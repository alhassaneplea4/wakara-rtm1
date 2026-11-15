"""
Text normalisation and fuzzy comparison primitives (pure functions, no database access).

Nothing here alters what was declared: the original values stay on the declaration tables,
only normalised copies (``BirthIdentity``) are used for matching.

Name comparison is deliberately tolerant — typing mistakes, phonetic variants (Kamara/Camara,
Mamadou/Mamadu, Aïssatou/Aisatou), reversed first/last names — and a similarity is NEVER a proof:
it only feeds a score that a human reviews.
"""
import datetime
import re
import unicodedata

# Words that carry no identity: honorifics and generic facility words.
NAME_STOPWORDS = {'mme', 'mlle', 'mr', 'm', 'dame', 'madame', 'monsieur', 'dr', 'docteur', 'feu', 'feue',
                  'epouse', 'veuve', 'ne', 'nee', 'de', 'du', 'des', 'la', 'le', 'el', 'al', 'bint', 'ben'}
PLACE_STOPWORDS = {'de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'au', 'aux', 'et', 'hopital', 'hop',
                   'clinique', 'centre', 'cs', 'chu', 'maternite', 'sante', 'medical', 'medicale',
                   'communal', 'communale', 'commune', 'quartier', 'secteur', 'conakry', 'guinee'}


def strip_accents(value: str) -> str:
    return ''.join(c for c in unicodedata.normalize('NFKD', value or '') if not unicodedata.combining(c))


def normalize_text(value) -> str:
    """Lower case, no accents, punctuation → single spaces, trimmed."""
    value = strip_accents(str(value or '')).lower().replace('œ', 'oe').replace('æ', 'ae')
    value = re.sub(r"[^a-z0-9]+", ' ', value)
    return re.sub(r'\s+', ' ', value).strip()


def tokens(value, stopwords=NAME_STOPWORDS) -> list:
    return [t for t in normalize_text(value).split() if t and t not in stopwords]


def name_key(*parts) -> str:
    """Order-independent key: sorted normalised tokens of every part (handles first/last inversion)."""
    toks = []
    for p in parts:
        toks.extend(tokens(p))
    return ' '.join(sorted(toks))


def normalize_phone(value) -> str:
    """Digits only; the Guinean country code (224) and leading zeros are ignored."""
    digits = re.sub(r'\D+', '', str(value or ''))
    if digits.startswith('00'):
        digits = digits[2:]
    if digits.startswith('224') and len(digits) > 9:
        digits = digits[3:]
    digits = digits.lstrip('0')
    return digits if len(digits) >= 6 else ''


def normalize_id(value) -> str:
    return re.sub(r'[^A-Z0-9]', '', strip_accents(str(value or '')).upper())


def normalize_place(value) -> str:
    return ' '.join(tokens(value, PLACE_STOPWORDS))


# ── Phonetics ─────────────────────────────────────

_PHONETIC_RULES = [
    (r'ph', 'f'), (r'ck', 'k'), (r'kh', 'k'), (r'gh', 'g'), (r'th', 't'), (r'ch', 'x'), (r'sh', 'x'),
    (r'tch', 'x'), (r'gn', 'n'), (r'qu', 'k'), (r'q', 'k'), (r'w', 'u'), (r'ou', 'u'), (r'oo', 'u'),
    (r'eau', 'o'), (r'au', 'o'), (r'ai', 'e'), (r'ei', 'e'), (r'ay', 'e'), (r'ey', 'e'),
    (r'c(?=[eiy])', 's'), (r'c', 'k'), (r'z', 's'), (r'y', 'i'), (r'x', 'ks'),
    (r'ss', 's'),
]


def phonetic_key(value) -> str:
    """
    Compact phonetic code of a name (consonant skeleton after French/Mande-friendly rewrites).
    ``Kamara``/``Camara`` → ``kmr``; ``Mamadou``/``Mamadu`` → ``mmd``; ``Aïssatou``/``Aisatou`` → ``est``.
    Several tokens are coded separately and sorted (inversions give the same key).
    """
    out = []
    for tok in tokens(value):
        s = tok
        for pattern, repl in _PHONETIC_RULES:
            s = re.sub(pattern, repl, s)
        s = re.sub(r'h', '', s)
        s = re.sub(r'(.)\1+', r'\1', s)                  # double letters
        s = re.sub(r'[dtsxz]$', '', s) if len(s) > 3 else s   # silent final consonants (Bah, Diallo, Barry stay)
        head, rest = s[:1], s[1:]
        rest = re.sub(r'[aeiou]', '', rest)
        code = re.sub(r'(.)\1+', r'\1', head + rest)
        if head in 'aeiou':
            code = 'a' + code[1:]                         # every initial vowel counts as one class
        if code:
            out.append(code)
    return ' '.join(sorted(out))


# ── Similarity ────────────────────────────────────

def jaro(a: str, b: str) -> float:
    if a == b:
        return 1.0
    la, lb = len(a), len(b)
    if not la or not lb:
        return 0.0
    window = max(max(la, lb) // 2 - 1, 0)
    a_flags, b_flags = [False] * la, [False] * lb
    matches = 0
    for i, ca in enumerate(a):
        for j in range(max(0, i - window), min(lb, i + window + 1)):
            if not b_flags[j] and b[j] == ca:
                a_flags[i] = b_flags[j] = True
                matches += 1
                break
    if not matches:
        return 0.0
    transpositions, k = 0, 0
    for i in range(la):
        if a_flags[i]:
            while not b_flags[k]:
                k += 1
            if a[i] != b[k]:
                transpositions += 1
            k += 1
    t = transpositions / 2
    return (matches / la + matches / lb + (matches - t) / matches) / 3


def jaro_winkler(a: str, b: str) -> float:
    j = jaro(a, b)
    prefix = 0
    for ca, cb in zip(a[:4], b[:4]):
        if ca != cb:
            break
        prefix += 1
    return j + prefix * 0.1 * (1 - j)


def token_similarity(a: str, b: str) -> float:
    """Similarity of two single normalised tokens (0..1): spelling, abbreviation and phonetics."""
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    # Jaro-Winkler gives ~0.5-0.65 to unrelated names that merely share letters: only a real resemblance
    # counts (0.6 → 0, 0.8 → 0.5, 0.95 → 0.875)
    best = max(0.0, min(1.0, (jaro_winkler(a, b) - 0.6) / 0.4))
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    if len(short) >= 3 and long_.startswith(short):      # Fatou / Fatoumata
        best = max(best, 0.9)
    if len(a) > 1 and len(b) > 1 and phonetic_key(a) == phonetic_key(b):
        best = max(best, 0.92)                            # sounds the same (Kamara / Camara)
    if len(a) == 1 and b.startswith(a) or len(b) == 1 and a.startswith(b):
        best = max(best, 0.6)                             # initial
    return best


def name_similarity(a, b) -> float:
    """
    Similarity of two names (0..1), independent of token order and tolerant to misspellings.
    Each token of the shorter name is matched to its best counterpart; the result is divided by the
    number of tokens of the longer one, so a missing first name lowers the score without cancelling it.
    """
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    if len(ta) > len(tb):
        ta, tb = tb, ta
    remaining = list(tb)
    total = 0.0
    for t in ta:
        best, best_i = 0.0, -1
        for i, u in enumerate(remaining):
            s = token_similarity(t, u)
            if s > best:
                best, best_i = s, i
        if best_i >= 0:
            total += best
            remaining.pop(best_i)
    return min(1.0, total / max(len(tb), 1))


def place_similarity(a, b) -> float:
    na, nb = normalize_place(a), normalize_place(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if na in nb or nb in na:
        return 0.9
    return name_similarity(na, nb)


# ── Dates and times ───────────────────────────────

def date_similarity(a, b) -> float:
    """1 same day · 0.7 day/month swapped · 0.6 one day apart · 0.5 one wrong digit · else 0."""
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a.year == b.year and a.day == b.month and a.month == b.day:
        return 0.7
    if abs((a - b).days) == 1:
        return 0.6
    sa, sb = a.isoformat(), b.isoformat()
    if sum(x != y for x, y in zip(sa, sb)) == 1:
        return 0.5
    return 0.0


def minutes_between(a: datetime.time, b: datetime.time) -> int:
    return abs((a.hour * 60 + a.minute) - (b.hour * 60 + b.minute))


def time_similarity(a, b) -> float:
    if not a or not b:
        return 0.0
    gap = minutes_between(a, b)
    if gap <= 5:
        return 1.0
    if gap <= 15:
        return 0.7
    if gap <= 60:
        return 0.3
    return 0.0

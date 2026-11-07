"""Neutralisation of spreadsheet formulas in CSV exports (CSV / formula injection)."""

# A spreadsheet application may evaluate a cell that starts with one of these characters.
FORMULA_PREFIXES = ('=', '+', '-', '@', '\t', '\r')


def safe_cell(value):
    """Prefix text cells that could be read as a formula with an apostrophe, so they stay plain text."""
    if isinstance(value, str) and value.startswith(FORMULA_PREFIXES):
        return "'" + value
    return value


def safe_row(row):
    return [safe_cell(v) for v in row]

"""
State machine of a birth dossier (declaration + acte), enforced server-side.

    DRAFT ──► TRANSMITTED ──► IN_COMPLETION ──► PENDING_VALIDATION ──► VALIDATED ──► DELIVERED
                  ▲                 ▲                  │
                  │                 └── TO_CORRECT_SECRETARIAT ◄┤
                  └──────── TO_CORRECT_COLLECTION ◄─────────────┤
                                                       REJECTED ◄┘  (closed)

The status list is a working proposal to be confirmed with the mairie
(see docs/business-decisions.md). Every transition names the permission it
requires, so authorisation never depends on the client.
"""
from dataclasses import dataclass

from django.core.exceptions import ValidationError


class Status:
    DRAFT = 'DRAFT'
    TRANSMITTED = 'TRANSMITTED'
    IN_COMPLETION = 'IN_COMPLETION'
    PENDING_VALIDATION = 'PENDING_VALIDATION'
    TO_CORRECT_COLLECTION = 'TO_CORRECT_COLLECTION'
    TO_CORRECT_SECRETARIAT = 'TO_CORRECT_SECRETARIAT'
    VALIDATED = 'VALIDATED'
    REJECTED = 'REJECTED'
    DELIVERED = 'DELIVERED'

    CHOICES = [
        (DRAFT, 'Brouillon'),
        (TRANSMITTED, 'Transmis au secrétariat'),
        (IN_COMPLETION, 'En complément'),
        (PENDING_VALIDATION, 'En attente de validation'),
        (TO_CORRECT_COLLECTION, 'À corriger — collecte'),
        (TO_CORRECT_SECRETARIAT, 'À corriger — secrétariat'),
        (VALIDATED, 'Validé définitivement'),
        (REJECTED, 'Rejeté'),
        (DELIVERED, 'Acte délivré'),
    ]
    ALL = [c for c, _ in CHOICES]

    # Statuses in which the hospital declaration data may still be edited.
    DECLARATION_EDITABLE = (DRAFT, TO_CORRECT_COLLECTION)
    # Statuses in which the acte data may be completed.
    ACTE_EDITABLE = (IN_COMPLETION, TO_CORRECT_SECRETARIAT)
    # Statuses after which the dossier is frozen.
    FROZEN = (VALIDATED, REJECTED, DELIVERED)
    # "In progress" for dashboards.
    IN_PROGRESS = (TRANSMITTED, IN_COMPLETION, TO_CORRECT_COLLECTION, TO_CORRECT_SECRETARIAT)


@dataclass(frozen=True)
class Transition:
    source: str
    target: str
    permission: str
    reason_required: bool = False
    # DELIVERED is only reachable through the delivery service.
    via_delivery: bool = False


TRANSITIONS = [
    Transition(Status.DRAFT, Status.TRANSMITTED, 'declaration.transmit'),
    Transition(Status.TRANSMITTED, Status.IN_COMPLETION, 'acte.complete'),
    Transition(Status.IN_COMPLETION, Status.PENDING_VALIDATION, 'acte.submit'),
    Transition(Status.PENDING_VALIDATION, Status.VALIDATED, 'dossier.validate'),
    Transition(Status.PENDING_VALIDATION, Status.TO_CORRECT_COLLECTION, 'dossier.reject', True),
    Transition(Status.PENDING_VALIDATION, Status.TO_CORRECT_SECRETARIAT, 'dossier.reject', True),
    Transition(Status.PENDING_VALIDATION, Status.REJECTED, 'dossier.reject', True),
    Transition(Status.TO_CORRECT_COLLECTION, Status.TRANSMITTED, 'declaration.transmit'),
    Transition(Status.TO_CORRECT_SECRETARIAT, Status.PENDING_VALIDATION, 'acte.submit'),
    Transition(Status.VALIDATED, Status.DELIVERED, 'acte.deliver', via_delivery=True),
]

_INDEX = {(t.source, t.target): t for t in TRANSITIONS}


def get_transition(source: str, target: str) -> Transition:
    """Return the transition or raise ValidationError(code='invalid_transition')."""
    t = _INDEX.get((source, target))
    if t is None:
        allowed = ', '.join(x.target for x in TRANSITIONS if x.source == source) or 'aucune'
        raise ValidationError(
            f"Transition de '{source}' vers '{target}' non autorisée. "
            f"Transitions possibles : {allowed}.",
            code='invalid_transition',
        )
    return t


def available_transitions(source: str):
    return [t for t in TRANSITIONS if t.source == source]

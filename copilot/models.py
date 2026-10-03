from __future__ import annotations

from dataclasses import asdict, dataclass, field

SEVERITIES = ("Critical", "Major", "Minor")


@dataclass
class Finding:
    check_id: str
    discipline: str
    severity: str
    sheet: str
    section: str
    comment: str
    evidence: str = ""
    source: str = "rules"
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Finding":
        known = {k: data[k] for k in cls.__dataclass_fields__ if k in data}
        known.setdefault("discipline", "Building")
        return cls(**known)


@dataclass
class ReviewResult:
    project_id: str
    accepted: list[Finding]
    rejected: list[tuple[Finding, list[str]]]
    audit_log: list[str]

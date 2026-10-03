"""Reference library of code sections the reviewer is allowed to cite.

Sections are from the 2021 International Building Code (IBC). Summaries are
paraphrased for this demo; they are not the code text. Always verify against the
adopted code and local amendments (for example, California's CBC Chapter 11B).
"""

CODE_EDITION = "IBC 2021"

SECTIONS: dict[str, str] = {
    "107.2.3": "Construction documents must show the means of egress in detail, including the number of occupants on every floor and in all rooms and spaces.",
    "903.2.1.2": "Group A-2 requires an automatic sprinkler system where the fire area exceeds 5,000 sq ft, the occupant load is 100 or more, or the fire area is on a floor other than the level of exit discharge.",
    "1004.3": "Assembly rooms must post the maximum occupant load near the main exit or exit access doorway.",
    "1004.5": "Occupant load is calculated by dividing floor area by the occupant load factor in Table 1004.5.",
    "1005.3.1": "Stairway egress capacity is based on 0.3 inch of width per occupant (reductions apply only under listed exceptions).",
    "1005.3.2": "Egress capacity for components other than stairways is based on 0.2 inch of width per occupant (reductions apply only under listed exceptions).",
    "1006.3.3": "Minimum number of exits per story: 2 for 1-500 occupants, 3 for 501-1,000, and 4 for more than 1,000 (Table 1006.3.3).",
    "1007.1.1": "Where two exits are required, they must be separated by at least one-half of the overall diagonal of the area served, or one-third where the building is fully sprinklered.",
    "1010.1.1": "Egress doors must provide a minimum clear opening width of 32 inches.",
    "1013.1": "Exit signs are required where two or more exits or exit access doorways are required.",
    "1017.2": "Exit access travel distance may not exceed the limits in Table 1017.2 for the occupancy and sprinkler condition.",
    "1020.3": "Corridors serving an occupant load of 50 or more must be at least 44 inches wide.",
    "1104.1": "At least one accessible route is required from site arrival points (public streets, accessible parking, loading zones) to an accessible building entrance.",
    "1109.2": "Toilet and bathing facilities must be accessible where they are provided.",
}

# Table 1004.5 factors used by the demo, in sq ft per occupant.
OCCUPANT_LOAD_FACTORS: dict[str, tuple[float, str]] = {
    "business": (150, "gross"),
    "mercantile": (60, "gross"),
    "assembly_unconcentrated": (15, "net"),
    "assembly_concentrated": (7, "net"),
    "classroom": (20, "net"),
    "commercial_kitchen": (200, "gross"),
    "storage": (300, "gross"),
}

# Table 1017.2 limits in feet: (not sprinklered, sprinklered).
TRAVEL_DISTANCE_LIMITS: dict[str, tuple[int, int]] = {
    "A": (200, 250),
    "B": (200, 300),
    "E": (200, 250),
    "M": (200, 250),
    "S-1": (200, 250),
}


def cite(section: str) -> str:
    return f"{CODE_EDITION} §{section}"


def is_known(section: str) -> bool:
    return section in SECTIONS

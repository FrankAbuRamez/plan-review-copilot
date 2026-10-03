"""Stage 1 (offline): deterministic first reviewer.

Each check reads the structured project record and returns findings with the
numbers that justify them. Checks only cover what the data can prove; anything
else is left to the LLM reviewer or a human.
"""
from __future__ import annotations

import math

from .code_refs import OCCUPANT_LOAD_FACTORS, TRAVEL_DISTANCE_LIMITS, cite
from .models import Finding


def occupant_load(project: dict) -> int:
    total = 0.0
    for space in project["spaces"]:
        factor, _basis = OCCUPANT_LOAD_FACTORS[space["use"]]
        total += math.ceil(space["area_sf"] / factor)
    return int(total)


def required_exits(load: int) -> int:
    if load > 1000:
        return 4
    if load > 500:
        return 3
    return 2


def _sheet(project: dict, key: str) -> str:
    return project.get("sheets", {}).get(key, "Code analysis")


def review(project: dict) -> list[Finding]:
    findings: list[Finding] = []
    load = occupant_load(project)
    exits = project.get("exits", [])
    sprinklered = project.get("sprinklered", False)
    documented = project.get("documented", {})
    is_assembly = project["occupancy"].startswith("A")
    egress_sheet = _sheet(project, "egress")

    def add(check_id, severity, sheet, section, comment, evidence, discipline="Building"):
        findings.append(Finding(check_id, discipline, severity, sheet, cite(section), comment, evidence))

    if not documented.get("occupant_load_on_plans", True):
        add("OL-DOC", "Major", _sheet(project, "code_analysis"), "107.2.3",
            "Provide an occupant load calculation for each room and space on the code analysis sheet, "
            "using the factors in Table 1004.5.",
            f"No occupant load shown; reviewer estimate is {load} occupants.")

    needed = required_exits(load)
    if len(exits) < needed:
        add("EXITS-COUNT", "Critical", egress_sheet, "1006.3.3",
            f"Revise the egress plan to provide at least {needed} exits from this story.",
            f"Occupant load {load} requires {needed} exits; {len(exits)} shown.")

    if len(exits) >= 2 and project.get("overall_diagonal_ft"):
        fraction = 1 / 3 if sprinklered else 1 / 2
        minimum = project["overall_diagonal_ft"] * fraction
        separation = project.get("exit_separation_ft", 0)
        if separation < minimum:
            add("EXIT-SEP", "Critical", egress_sheet, "1007.1.1",
                f"Revise exit locations so they are separated by at least {minimum:.0f} ft, "
                "measured in a straight line between the nearest edges of the exit doors.",
                f"Diagonal {project['overall_diagonal_ft']} ft x {'1/3' if sprinklered else '1/2'} = "
                f"{minimum:.0f} ft required; {separation} ft shown.")

    door_width = sum(e["door_clear_width_in"] for e in exits)
    required_width = load * 0.2
    if exits and door_width < required_width:
        add("EGRESS-WIDTH", "Critical", egress_sheet, "1005.3.2",
            f"Revise exit doors to provide at least {required_width:.0f} in. of total egress width.",
            f"{load} occupants x 0.2 in. = {required_width:.0f} in. required; {door_width} in. provided.")

    stair = project.get("stair_width_in")
    if stair and project.get("stories", 1) > 1:
        upper_load = project.get("upper_floor_occupant_load", load)
        need = upper_load * 0.3
        if stair < need:
            add("STAIR-WIDTH", "Critical", egress_sheet, "1005.3.1",
                f"Revise stair width to provide at least {need:.0f} in. of egress capacity.",
                f"{upper_load} occupants x 0.3 in. = {need:.0f} in. required; {stair} in. provided.")

    narrow = [e["id"] for e in exits if e["door_clear_width_in"] < 32]
    if narrow:
        add("DOOR-WIDTH", "Major", _sheet(project, "door_schedule"), "1010.1.1",
            f"Revise door(s) {', '.join(narrow)} to provide a minimum 32 in. clear opening width.",
            "Clear widths: " + ", ".join(f"{e['id']}={e['door_clear_width_in']} in." for e in exits))

    limits = TRAVEL_DISTANCE_LIMITS.get(project.get("group_letter", project["occupancy"][0]))
    travel = project.get("max_travel_distance_ft")
    if limits and travel:
        limit = limits[1] if sprinklered else limits[0]
        if travel > limit:
            add("TRAVEL", "Critical", egress_sheet, "1017.2",
                f"Revise the layout or add an exit so exit access travel distance does not exceed {limit} ft.",
                f"Longest travel path {travel} ft; limit {limit} ft "
                f"({'sprinklered' if sprinklered else 'not sprinklered'}).")

    for corridor in project.get("corridors", []):
        if corridor["occupant_load_served"] >= 50 and corridor["width_in"] < 44:
            add("CORRIDOR", "Major", egress_sheet, "1020.3",
                f"Revise the {corridor['name']} to a minimum 44 in. clear width.",
                f"Serves {corridor['occupant_load_served']} occupants; {corridor['width_in']} in. shown.")

    if project["occupancy"] == "A-2" and not sprinklered:
        reasons = []
        if project.get("fire_area_sf", 0) > 5000:
            reasons.append(f"fire area {project['fire_area_sf']} sq ft > 5,000")
        if load >= 100:
            reasons.append(f"occupant load {load} >= 100")
        if not project.get("at_level_of_exit_discharge", True):
            reasons.append("not on the level of exit discharge")
        if reasons:
            add("SPRINKLER-A2", "Critical", _sheet(project, "code_analysis"), "903.2.1.2",
                "Provide an automatic sprinkler system throughout the fire area, "
                "or revise the design so none of the triggers apply.",
                "Triggered by: " + "; ".join(reasons), discipline="Fire")

    if is_assembly and not documented.get("occupant_load_posting", True):
        add("POSTING", "Minor", egress_sheet, "1004.3",
            "Provide a note and location for the posted maximum occupant load sign.",
            "No occupant load posting shown for an assembly room.")

    if needed >= 2 and not documented.get("exit_signs_shown", True):
        add("EXIT-SIGNS", "Major", egress_sheet, "1013.1",
            "Provide exit sign locations on the egress plan.",
            f"{needed} exits required; no exit signs shown.")

    return findings

#!/usr/bin/env python3
"""Generate the editable DRAFT visual identity document for the cc plugin family."""

from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


PAGE_W, PAGE_H = landscape(A4)
ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "output" / "pdf" / "cc-plugin-family-visual-identity-draft.pdf"

BG = HexColor("#0D0D0D")
PANEL = HexColor("#151514")
SURFACE = HexColor("#1A1A19")
BORDER = HexColor("#2C2C2A")
RAIL = HexColor("#383835")
RUST = HexColor("#C96442")
PETROL = HexColor("#5FA8A8")
INK = HexColor("#EEF0F2")
INK_2 = HexColor("#C3C2B7")
MUTED = HexColor("#898781")

PROVIDERS = [
    ("CLAUDE", HexColor("#C96442")),
    ("GLM", HexColor("#C0C0C0")),
    ("DEEPSEEK", HexColor("#4D6BFE")),
    ("QWEN", HexColor("#653AFF")),
    ("OPENROUTER", HexColor("#C8FF00")),
]


def set_alpha(c, stroke=1, fill=1):
    c.setStrokeAlpha(stroke)
    c.setFillAlpha(fill)


def label(c, text, x, y, size=8, color=MUTED, tracking=1.4):
    c.saveState()
    c.setFillColor(color)
    t = c.beginText(x, y)
    t.setFont("Courier-Bold", size)
    t.setCharSpace(tracking)
    t.textLine(text.upper())
    c.drawText(t)
    c.restoreState()


def body(c, text, x, y, size=10, color=INK_2, leading=15, max_width=None):
    words = text.split()
    lines = []
    line = ""
    for word in words:
        candidate = f"{line} {word}".strip()
        if max_width and stringWidth(candidate, "Helvetica", size) > max_width and line:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    c.setFillColor(color)
    c.setFont("Helvetica", size)
    for i, item in enumerate(lines):
        c.drawString(x, y - i * leading, item)
    return y - len(lines) * leading


def title(c, lead, rest, x, y, size=34):
    c.setFont("Helvetica-Bold", size)
    c.setFillColor(RUST)
    c.drawString(x, y, lead)
    offset = stringWidth(lead, "Helvetica-Bold", size)
    c.setFillColor(INK)
    c.drawString(x + offset, y, rest)


def page_base(c, page_no, section):
    c.setFillColor(BG)
    c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    c.setStrokeColor(BORDER)
    c.setLineWidth(0.7)
    c.line(42, PAGE_H - 39, PAGE_W - 42, PAGE_H - 39)
    label(c, "CC PLUGIN FAMILY", 42, PAGE_H - 27, 7.2, MUTED, 1.5)
    label(c, section, PAGE_W / 2 - 25, PAGE_H - 27, 7.2, MUTED, 1.3)
    c.setFillColor(RUST)
    c.roundRect(PAGE_W - 112, PAGE_H - 31, 70, 15, 3, stroke=0, fill=1)
    c.setFillColor(BG)
    c.setFont("Courier-Bold", 7.4)
    c.drawCentredString(PAGE_W - 77, PAGE_H - 26.5, "DRAFT 01")
    label(c, f"{page_no:02d} / 06", PAGE_W - 84, 22, 7, MUTED, 1.1)


def ring(c, x, y, r, color, width=7, alpha=1):
    c.saveState()
    set_alpha(c, stroke=alpha)
    c.setStrokeColor(color)
    c.setFillColor(BG)
    c.setLineWidth(width)
    c.circle(x, y, r, stroke=1, fill=1)
    c.restoreState()


def mark(c, x, y, size, kind="proxy", tile=True):
    if tile:
        c.setFillColor(BG)
        c.roundRect(x, y, size, size, size * 0.17, stroke=0, fill=1)

    c.saveState()
    c.translate(x, y + size)
    scale = size / 240
    c.scale(scale, -scale)
    c.setLineCap(1)
    c.setLineJoin(1)

    if kind == "proxy":
        c.setStrokeColor(PETROL)
        c.setLineWidth(9)
        p = c.beginPath()
        p.moveTo(58, 120)
        p.lineTo(106, 120)
        p.lineTo(146, 64)
        p.lineTo(164, 64)
        p.moveTo(106, 120)
        p.lineTo(164, 120)
        p.moveTo(106, 120)
        p.lineTo(146, 176)
        p.lineTo(164, 176)
        c.drawPath(p, stroke=1, fill=0)
        ring(c, 38, 120, 15, RUST, 8)
        ring(c, 185, 64, 13, RUST, 7)
        ring(c, 185, 120, 13, INK, 7)
        ring(c, 185, 176, 13, INK, 7)

    elif kind == "operator":
        c.setStrokeColor(RAIL)
        c.setLineWidth(8)
        p = c.beginPath()
        p.moveTo(58, 120)
        p.lineTo(101, 120)
        p.moveTo(139, 82)
        p.lineTo(165, 56)
        p.lineTo(183, 56)
        p.moveTo(139, 120)
        p.lineTo(183, 120)
        p.moveTo(139, 158)
        p.lineTo(165, 184)
        p.lineTo(183, 184)
        c.drawPath(p, stroke=1, fill=0)
        c.setStrokeColor(PETROL)
        c.setLineWidth(9)
        p = c.beginPath()
        p.moveTo(58, 120)
        p.lineTo(101, 120)
        p.moveTo(131, 93)
        p.lineTo(165, 56)
        p.lineTo(183, 56)
        c.drawPath(p, stroke=1, fill=0)
        ring(c, 38, 120, 15, RUST, 8)
        ring(c, 120, 120, 31, RUST, 8)
        c.setStrokeColor(RUST)
        c.setLineWidth(7)
        c.line(120, 120, 139, 93)
        ring(c, 185, 56, 13, RUST, 7)
        ring(c, 185, 120, 13, INK, 7, 0.35)
        ring(c, 185, 184, 13, INK, 7, 0.35)

    elif kind == "reload":
        ring(c, 38, 120, 15, RUST, 8)
        c.setStrokeColor(PETROL)
        c.setLineWidth(9)
        p = c.beginPath()
        p.moveTo(58, 120)
        p.lineTo(86, 120)
        p.curveTo(86, 81, 116, 50, 154, 50)
        p.curveTo(192, 50, 222, 81, 222, 120)
        p.curveTo(222, 159, 192, 190, 154, 190)
        p.curveTo(124, 190, 98, 170, 89, 142)
        c.drawPath(p, stroke=1, fill=0)
        c.setStrokeColor(INK)
        c.setLineWidth(7)
        p = c.beginPath()
        p.moveTo(76, 151)
        p.lineTo(89, 142)
        p.lineTo(98, 156)
        c.drawPath(p, stroke=1, fill=0)
        ring(c, 154, 120, 13, INK, 7)

    elif kind == "statusline":
        c.setStrokeColor(PETROL)
        c.setLineWidth(9)
        p = c.beginPath()
        p.moveTo(58, 120)
        p.lineTo(92, 120)
        p.lineTo(106, 93)
        p.lineTo(130, 147)
        p.lineTo(148, 120)
        p.lineTo(182, 120)
        c.drawPath(p, stroke=1, fill=0)
        ring(c, 38, 120, 15, RUST, 8)
        ring(c, 202, 120, 13, INK, 7)
        c.saveState()
        set_alpha(c, stroke=0.35)
        c.setStrokeColor(INK)
        c.setLineWidth(5)
        for tx in (76, 164):
            c.line(tx, 77, tx, 95)
            c.line(tx, 145, tx, 163)
        c.restoreState()

    c.restoreState()


def wordmark(c, x, y, suffix, size=24):
    c.setFont("Helvetica-Bold", size)
    c.setFillColor(RUST)
    c.drawString(x, y, "cc")
    offset = stringWidth("cc", "Helvetica-Bold", size)
    c.setFillColor(INK)
    c.drawString(x + offset, y, f"-{suffix}")


def card(c, x, y, w, h, heading=None):
    c.setFillColor(PANEL)
    c.setStrokeColor(BORDER)
    c.setLineWidth(0.8)
    c.roundRect(x, y, w, h, 14, stroke=1, fill=1)
    if heading:
        label(c, heading, x + 18, y + h - 25, 7.3, MUTED, 1.2)


def cover(c):
    page_base(c, 1, "VISUAL IDENTITY")
    label(c, "CLAUDE CODE PLUGIN SYSTEM", 54, PAGE_H - 92, 8, PETROL, 1.8)
    title(c, "cc", " plugin family", 54, PAGE_H - 145, 42)
    c.setFillColor(INK_2)
    c.setFont("Helvetica", 17)
    c.drawString(55, PAGE_H - 178, "A shared visual language for local tools with distinct jobs.")
    label(c, "ONE INPUT / ONE CC ACTION / A RESOLVED OUTPUT", 56, PAGE_H - 213, 7.5, MUTED, 1.4)
    mark(c, 55, 84, 232, "proxy", True)
    c.setStrokeColor(BORDER)
    c.line(330, 86, 330, 356)
    wordmark(c, 378, 300, "proxy", 50)
    c.setFillColor(INK_2)
    c.setFont("Courier", 13)
    c.drawString(381, 267, "one proxy to rule them all.")
    body(
        c,
        "This draft establishes the first family grammar around cc-proxy and proposes sibling marks for Operator, Reload and Statusline.",
        380,
        215,
        11,
        INK_2,
        17,
        365,
    )
    label(c, "STATUS", 380, 142, 7, MUTED, 1.4)
    c.setFillColor(RUST)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(380, 120, "DRAFT - REQUIRES A LATER REVISION")
    label(c, "07 AUG 2026 / INTERNAL DESIGN DOCUMENT", 380, 94, 7, MUTED, 1.2)
    c.showPage()


def principles(c):
    page_base(c, 2, "FAMILY GRAMMAR")
    title(c, "Three", " semantic layers", 46, PAGE_H - 92, 31)
    body(c, "Color is assigned by ownership, not decoration.", 47, PAGE_H - 120, 11, INK_2)
    cols = [
        ("01 / INPUT", RUST, "Claude-originated intent enters the plugin system."),
        ("02 / ACTION", PETROL, "The cc plugin performs its own named operation."),
        ("03 / OUTPUT", INK, "A route, choice or state is resolved and made legible."),
    ]
    for i, (head, color, copy) in enumerate(cols):
        x = 46 + i * 258
        card(c, x, 238, 232, 190, head)
        c.setStrokeColor(color)
        c.setLineWidth(8)
        c.line(x + 24, 340, x + 178, 340)
        ring(c, x + 27, 340, 14, color, 7)
        body(c, copy, x + 20, 300, 10, INK_2, 15, 190)
    card(c, 46, 74, PAGE_W - 92, 130, "CORE PALETTE")
    palette = [
        ("CLAUDE INPUT", RUST, "#C96442"),
        ("CC ACTION", PETROL, "#5FA8A8"),
        ("RESOLVED", INK, "#EEF0F2"),
        ("CANVAS", BG, "#0D0D0D"),
        ("MUTED", MUTED, "#898781"),
    ]
    for i, (name, color, value) in enumerate(palette):
        x = 66 + i * 145
        c.setFillColor(color)
        c.roundRect(x, 128, 112, 30, 6, stroke=0, fill=1)
        label(c, name, x, 108, 6.4, MUTED, 0.8)
        c.setFont("Courier", 8)
        c.setFillColor(INK_2)
        c.drawString(x, 91, value)
    c.showPage()


def proxy_reference(c):
    page_base(c, 3, "REFERENCE BRAND")
    title(c, "cc", "-proxy", 46, PAGE_H - 92, 31)
    body(c, "The first completed mark defines the family construction rules.", 47, PAGE_H - 120, 11, INK_2)
    card(c, 46, 82, 286, 365, "PRIMARY MARK")
    mark(c, 70, 150, 238, "proxy", True)
    wordmark(c, 98, 113, "proxy", 27)
    card(c, 352, 263, 443, 184, "ROUTING LOGIC")
    c.setStrokeColor(PETROL)
    c.setLineWidth(3)
    c.line(391, 352, 468, 352)
    c.roundRect(468, 329, 112, 46, 10, stroke=1, fill=0)
    c.line(580, 352, 627, 352)
    for i, (name, color) in enumerate(PROVIDERS):
        ey = 396 - i * 23
        c.line(627, 352, 663, ey)
        ring(c, 675, ey, 6, color, 3)
        label(c, name, 692, ey - 2, 6.4, MUTED, 0.8)
    ring(c, 380, 352, 7, RUST, 4)
    wordmark(c, 489, 345, "proxy", 11)
    card(c, 352, 82, 443, 160, "CONSTRUCTION")
    rules = [
        "ROUTES STOP BEFORE NODE RINGS",
        "ROUTING STROKE: 18 / 240 UNITS",
        "INPUT: RUST / ACTION: PETROL",
        "TOP EXIT: RUST / OTHER EXITS: WARM WHITE",
        "NO GRADIENTS / GLOW / PERSPECTIVE / MASCOTS",
    ]
    for i, rule in enumerate(rules):
        yy = 199 - i * 24
        c.setFillColor(PETROL if i == 0 else BORDER)
        c.circle(375, yy + 2, 3, stroke=0, fill=1)
        label(c, rule, 389, yy, 7.1, INK_2, 0.75)
    c.showPage()


def family_overview(c):
    page_base(c, 4, "PROPOSED FAMILY")
    title(c, "One", " grammar, four jobs", 46, PAGE_H - 92, 31)
    body(c, "Each mark preserves the family syntax while making a different verb visible.", 47, PAGE_H - 120, 11, INK_2)
    items = [
        ("proxy", "ROUTE / ONE TO MANY"),
        ("operator", "SELECT / ONE INTENTIONAL PATH"),
        ("reload", "RETURN / REFRESH IN PLACE"),
        ("statusline", "SIGNAL / STATE AT A GLANCE"),
    ]
    for i, (name, action) in enumerate(items):
        x = 43 + i * 199
        card(c, x, 100, 184, 340)
        mark(c, x + 15, 224, 154, name, True)
        wordmark(c, x + 18, 187, name, 17)
        label(c, action, x + 18, 159, 5.8, MUTED, 0.55)
        body(
            c,
            {
                "proxy": "Branches one request into several named destinations.",
                "operator": "Makes one deliberate selection from multiple available paths.",
                "reload": "Returns through a controlled loop without losing identity.",
                "statusline": "Turns continuous state into a readable signal at a glance.",
            }[name],
            x + 18,
            135,
            8.5,
            INK_2,
            13,
            148,
        )
    c.showPage()


def proposals(c):
    page_base(c, 5, "SIBLING MARKS")
    title(c, "Three", " proposed verbs", 46, PAGE_H - 92, 31)
    rows = [
        ("operator", "SELECT", "Rust marks both the selector and selected endpoint. Unselected exits remain dimmed warm white."),
        ("reload", "RETURN", "A continuous petrol loop expresses re-entry; the white arrow and center node resolve the action."),
        ("statusline", "SIGNAL", "The baseline carries one readable pulse. Dimmed white ticks suggest a persistent status frame."),
    ]
    for i, (name, verb, copy) in enumerate(rows):
        y = 348 - i * 143
        mark(c, 49, y, 118, name, True)
        label(c, f"CC-{name.upper()} / {verb}", 193, y + 91, 7.5, PETROL, 1.05)
        wordmark(c, 193, y + 53, name, 24)
        body(c, copy, 193, y + 26, 10, INK_2, 15, 465)
        if i < 2:
            c.setStrokeColor(BORDER)
            c.line(47, y - 14, PAGE_W - 47, y - 14)
    c.showPage()


def revision(c):
    page_base(c, 6, "REVISION NOTES")
    title(c, "Open", " decisions for revision 02", 46, PAGE_H - 92, 31)
    body(c, "This document records direction, not final production approval.", 47, PAGE_H - 120, 11, INK_2)
    items = [
        ("01", "SMALL-SIZE TEST", "Verify every mark at 16, 24, 32 and 48 px before release."),
        ("02", "OPERATOR SEMANTICS", "Confirm that the active selector matches the plugin's real interaction model."),
        ("03", "RELOAD DISTINCTIVENESS", "Check the return loop against generic refresh-icon conventions."),
        ("04", "STATUSLINE RHYTHM", "Tune pulse amplitude and tick spacing against the actual terminal statusline."),
        ("05", "LIGHT SURFACE", "Define controlled light-background variants without changing semantic colors."),
        ("06", "PRODUCTION EXPORTS", "Prepare SVG, PNG and repository banner variants after approval."),
    ]
    for i, (num, head, copy) in enumerate(items):
        col = i % 2
        row = i // 2
        x = 46 + col * 391
        y = 390 - row * 105
        card(c, x, y - 65, 368, 86)
        c.setFillColor(RUST)
        c.setFont("Courier-Bold", 10)
        c.drawString(x + 17, y - 3, num)
        label(c, head, x + 52, y - 3, 7.2, INK, 0.9)
        body(c, copy, x + 52, y - 27, 8.5, MUTED, 13, 292)
    c.setStrokeColor(RUST)
    c.setLineWidth(1.5)
    c.line(47, 78, PAGE_W - 47, 78)
    label(c, "DRAFT 01 / DO NOT TREAT AS FINAL BRAND APPROVAL", 47, 56, 8, RUST, 1.35)
    c.showPage()


def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT), pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    c.setTitle("CC Plugin Family - Visual Identity - DRAFT 01")
    c.setAuthor("cc plugin family")
    c.setSubject("Draft visual identity system for cc-proxy, cc-operator, cc-reload and cc-statusline")
    cover(c)
    principles(c)
    proxy_reference(c)
    family_overview(c)
    proposals(c)
    revision(c)
    c.save()
    print(OUTPUT)


if __name__ == "__main__":
    main()

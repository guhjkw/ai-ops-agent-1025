"""
tests/browser-check.py
Playwright checks that drive the real page (index.html), which loads the same src/agentEngine.js
that tests/verify.js tests. Animations are sped up with ?fast=1.
Run:  python3 build.py && python3 tests/browser-check.py      (expects "0 failed" on the last line)
"""
import functools, http.server, pathlib, threading
from html.parser import HTMLParser
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
passed = failed = 0
def check(name, cond, detail=None):
    global passed, failed
    if cond: passed += 1; print(f"PASS: {name}")
    else: failed += 1; print(f"FAIL: {name}" + (f"  -> {detail}" if detail is not None else ""))

class Balance(HTMLParser):
    VOID = {"meta", "link", "br", "input", "img", "hr", "source", "wbr", "col", "path", "rect", "circle", "stop", "polyline", "line"}
    def __init__(self): super().__init__(); self.stack, self.errors = [], []
    def handle_starttag(self, tag, attrs):
        if tag not in self.VOID: self.stack.append(tag)
    def handle_startendtag(self, tag, attrs): pass
    def handle_endtag(self, tag):
        if tag in self.VOID: return
        if not self.stack or self.stack[-1] != tag: self.errors.append(f"unexpected </{tag}> open {self.stack[-3:]}")
        else: self.stack.pop()

print("0. HTML tag balance")
b = Balance(); b.feed((ROOT / "index.html").read_text())
check("all tags closed and nested", not b.errors and not b.stack, b.errors[:3] or b.stack[-3:])

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT)); handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler); threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{srv.server_address[1]}/index.html?fast=1"
problems = []

def metric(pg, i): return pg.locator("#metrics .metric b").nth(i).text_content().strip()
def status(pg, mid): return pg.locator(f'#inbox [data-id="{mid}"] .st').text_content().strip()
def run_all(pg):
    pg.click("#runAll")
    pg.wait_for_function("document.querySelectorAll('#inbox .st.running').length === 0 && [...document.querySelectorAll('#inbox .st')].every(s => s.textContent !== 'Queued')", timeout=30000)
    pg.wait_for_timeout(150)
def tab(pg, t): pg.click(f'#tabs [data-tab="{t}"]'); pg.wait_for_timeout(60)

with sync_playwright() as pw:
    br = pw.chromium.launch()
    pg = br.new_page(viewport={"width": 1440, "height": 900})
    pg.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: problems.append(str(e)))
    pg.goto(url); pg.wait_for_function("document.querySelectorAll('#inbox .it').length === 12")

    print("1. Page loads")
    check("12 inbound messages are listed, all queued", pg.locator("#inbox .it").count() == 12 and all(s.strip() == "Queued" for s in pg.locator("#inbox .st").all_text_contents()))
    check("totals start at zero", metric(pg, 0) == "0/12" and metric(pg, 1) == "0")
    check("data check reports 0 skipped rows", "0 rows skipped" in pg.locator("#dataCheck").text_content())
    check("the CRM starts with the three existing clients' deals", pg.locator("#sys tr").count() == 3)
    pg.screenshot(path=str(TESTS / "screenshot-hero.png"))

    print("2. Run the whole inbox")
    run_all(pg)
    check("totals: 12 processed, 6 handled alone, 5 waiting, 2 with a person", [metric(pg, i) for i in range(4)] == ["12/12", "6", "5", "2"], [metric(pg, i) for i in range(6)])
    check("1 duplicate stopped and 1 API retry", metric(pg, 4) == "1" and metric(pg, 5) == "1")
    check("statuses match the decisions", [status(pg, m) for m in ["M-01", "M-03", "M-04", "M-08", "M-11"]] == ["Waiting for you", "Done", "Escalated", "Done", "Blocked"])
    check("7 items in the queue (5 approvals + 2 for a person)", pg.locator("#queue .ap").count() == 7 and pg.locator("#qCount").text_content() == "7")
    tab(pg, "crm")
    check("CRM: two new leads added (5 deals), the duplicate did not add a third", pg.locator("#sys tr").count() == 5 and pg.locator("#sys tr.new").count() == 0 or pg.locator("#sys tr").count() == 5)
    tab(pg, "help")
    check("Helpdesk: tickets for the change, the complaint and the refund", pg.locator("#sys tr").count() == 4)
    tab(pg, "sent")
    check("only the two client acknowledgements were sent without a person", pg.locator("#sys tr").count() == 2)
    pg.locator("#console").screenshot(path=str(TESTS / "screenshot-console.png"))

    print("3. Run trace")
    pg.click('#inbox [data-id="M-05"]'); pg.wait_for_timeout(120)
    check("M-05 trace shows the 429 and the retry", "429" in pg.locator("#trace").text_content() and pg.locator("#trace .node.retry").count() == 1)
    check("M-05 trace goes Trigger > Read > Classify > Extract > Match > Decide", [n.get_attribute("data-node") for n in pg.locator("#trace .node").all()][:6] == ["Trigger", "Read", "Classify", "Extract", "Match", "Decide"])
    check("every decision shows the rule behind it", pg.locator("#trace .act").count() >= 1 and "Rule:" in pg.locator("#trace .dec").text_content())
    pg.click('#inbox [data-id="M-07"]'); pg.wait_for_timeout(120)
    check("M-07: the reply sent confirms Thursday at 3 PM", "Thursday, October 29 at 3 PM" in pg.locator("#trace").text_content())
    tab(pg, "cal")
    check("Calendar: the strategy call shows as moved by the agent", "moved by the agent" in pg.locator("#sys").text_content())
    pg.click('#inbox [data-id="M-09"]'); pg.wait_for_timeout(120)
    check("M-09: the repeat form is a duplicate, merged with no second reply", "Duplicate of M-02" in pg.locator("#trace").text_content())
    pg.click('#inbox [data-id="M-01"]'); pg.wait_for_timeout(120)
    check("M-01: logs mask the phone number", "(***) ***-0148" in pg.locator("#trace").text_content() and "555-0148" not in pg.locator("#trace .node").first.text_content())
    pg.locator("#trace").screenshot(path=str(TESTS / "screenshot-trace.png"))

    print("4. Approvals")
    pg.click('#queue [data-ap="A-1"] [data-yes]'); pg.wait_for_timeout(100)
    tab(pg, "sent")
    check("approving the M-01 reply sends it (3 sent) and M-01 is done", pg.locator("#sys tr").count() == 3 and status(pg, "M-01") == "Done")
    bill = pg.locator("#queue .ap", has_text="INV-2207").get_attribute("data-ap")
    pg.click(f'#queue [data-ap="{bill}"] [data-no]'); pg.wait_for_timeout(100)
    tab(pg, "acc")
    check("rejecting the $2,340 bill marks it rejected in accounting", "rejected" in pg.locator("#sys").text_content())
    check("the waiting count drops to 3", metric(pg, 2) == "3")

    print("5. Running again changes nothing")
    deals_before = None
    tab(pg, "crm"); deals_before = pg.locator("#sys tr").count()
    run_all(pg)
    tab(pg, "crm")
    check("a second run adds no deals", pg.locator("#sys tr").count() == deals_before)
    tab(pg, "sent")
    check("a second run sends nothing new", pg.locator("#sys tr").count() == 3)

    print("6. Write your own message")
    pg.click("#writeBtn")
    pg.fill("#cEmail", "not-an-email"); pg.click("#cRun"); pg.wait_for_timeout(80)
    check("an invalid sender email is refused with a reason", "valid sender email" in pg.locator("#cErr").text_content() and pg.locator("#inbox .it").count() == 12)
    pg.fill("#cEmail", "alex@summitroof.example"); pg.click("#cRun")
    pg.wait_for_function("document.querySelector('#inbox [data-id=\"NEW-1\"] .st').textContent !== 'Running'", timeout=10000); pg.wait_for_timeout(100)
    check("a brand-new lead is processed: CRM deal at $3,000/month", "Summit Roofing" in pg.locator("#trace").text_content() and "$3,000/month" in pg.locator("#trace").text_content())
    pg.click('#sugg [data-s="phish"]'); pg.click("#cRun")
    pg.wait_for_function("document.querySelector('#inbox [data-id=\"NEW-2\"] .st').textContent !== 'Running'", timeout=10000); pg.wait_for_timeout(100)
    check("a pasted phishing email is blocked", status(pg, "NEW-2") == "Blocked")
    pg.click('#sugg [data-s="move"]'); pg.click("#cRun")
    pg.wait_for_function("document.querySelector('#inbox [data-id=\"NEW-3\"] .st').textContent !== 'Running'", timeout=10000); pg.wait_for_timeout(100)
    check("moving a call onto a busy time offers other times instead", "already booked" in pg.locator("#trace").text_content() and status(pg, "NEW-3") == "Waiting for you")
    pg.click('#sugg [data-s="junk"]'); pg.click("#cRun")
    pg.wait_for_function("document.querySelector('#inbox [data-id=\"NEW-4\"] .st').textContent !== 'Running'", timeout=10000); pg.wait_for_timeout(100)
    check("gibberish goes to a person, not a guess", status(pg, "NEW-4") == "Escalated")

    print("7. Rules change the outcome")
    pg.locator("#rLimit").fill("5000"); pg.locator("#rLimit").dispatch_event("input")
    pg.click("#rerun")
    pg.wait_for_function("[...document.querySelectorAll('#inbox .st')].every(s => s.textContent !== 'Queued' && s.textContent !== 'Running')", timeout=30000); pg.wait_for_timeout(150)
    check("bill limit $5,000: the $2,340 bill is handled alone (M-05 done)", status(pg, "M-05") == "Done")
    check("rerun starts from a clean slate (12 items, composer items gone)", pg.locator("#inbox .it").count() == 12)
    pg.locator("#rLimit").fill("500"); pg.locator("#rLimit").dispatch_event("input")
    pg.click("#rLeads"); pg.click("#rerun")
    pg.wait_for_function("[...document.querySelectorAll('#inbox .st')].every(s => s.textContent !== 'Queued' && s.textContent !== 'Running')", timeout=30000); pg.wait_for_timeout(150)
    tab(pg, "sent")
    check("lead replies on: the two lead replies also go out (4 sent)", pg.locator("#sys tr").count() == 4)

    print("8. Phone layout")
    mob = br.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    mob.on("pageerror", lambda e: problems.append(str(e)))
    mob.goto(url); mob.wait_for_function("document.querySelectorAll('#inbox .it').length === 12")
    check("no sideways scrolling on a phone", mob.evaluate("document.documentElement.scrollWidth - window.innerWidth") <= 1)
    mob.click("#runAll")
    mob.wait_for_function("[...document.querySelectorAll('#inbox .st')].every(s => s.textContent !== 'Queued' && s.textContent !== 'Running')", timeout=30000); mob.wait_for_timeout(150)
    fits = mob.evaluate("Math.max(...[...document.querySelectorAll('#console, .node, .ap, .tier, .metric')].map(e => e.getBoundingClientRect().right)) <= window.innerWidth + 1")
    check("console, trace nodes, queue and prices fit the screen", fits)
    check("still no sideways scrolling after a full run", mob.evaluate("document.documentElement.scrollWidth - window.innerWidth") <= 1)
    mob.locator("#trace").screenshot(path=str(TESTS / "screenshot-mobile.png"))
    pg.screenshot(path=str(TESTS / "screenshot-full.png"), full_page=True)
    br.close()

check("no console or page errors", not problems, problems[:5])
print(f"\n{passed} passed, {failed} failed")

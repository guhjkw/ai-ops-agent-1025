# AI ops agent (portfolio demo)

An AI ops agent for an invented marketing and web agency, **Fernway Digital**. It reads every inbound email and website form and works out what each one is. It pulls out the details, checks the CRM, and decides what to do under the agency's own rules: update the CRM, open a ticket, draft a bill, move a meeting, archive or quarantine. Anything risky goes to a person, with its reasoning. Every step is shown as a live run trace and logged with personal details masked.

**Live:** not deployed yet (deploy needs Taiwo's yes).

## What it does
| Message | What the agent does | Why (the rule) |
|---|---|---|
| New lead, $8,000/month | CRM company, contact and deal now; alert the account manager; drafts a reply with two real free call times | New leads always go into the CRM; first replies to new leads wait for approval |
| Same web form twice | Merged into the first deal. No second record, no second reply | Same sender and request within 24 hours |
| Client change request | Helpdesk ticket for the web lead, due "by Friday" (Friday 30 Oct); acknowledgement sent | Client acknowledgements go out on their own |
| "We will cancel" from a client | Urgent ticket, alert, hand to a person; the holding reply is only a draft | An unhappy client gets a human, not a bot |
| $2,340 contractor invoice | Bill drafted and waiting for finance. The accounting API fails once (429) and the agent retries | Over the $500 limit; the agent never pays bills |
| $49 recurring receipt | Bill drafted, approved by rule | Known amount from a known vendor |
| "Move Friday's call to Thursday at 3pm" | Moves the event if the slot is free and confirms; offers two free times if not | The calendar is never double-booked |
| Sales pitch | Archived, no reply | |
| Pricing question + "our invoice was wrong" | To a person, noting the sender is not in the CRM | Two requests in one message, low confidence |
| Phishing ("verify your password") | Quarantined, security alert, no link opened | |
| Refund request | Billing ticket; refund waits for a person | The agent never moves money |

## Try it
Open the live link, or `index.html` directly (it works off disk). Press **Run inbox**, click any message to see its trace, approve or reject from the queue, and use **Write your own** to send it a message it has never seen. Change a rule and press **Run the inbox with these rules**.

## Files
```
index.html               the console (built from index.src.html with the sample data embedded)
index.src.html           the console source
build.py                 builds index.html
src/agentEngine.js       classify, extract, match, decide, act, approvals, retries, masked logs
data/inbox.json          invented agency, inbox, CRM, helpdesk, accounting and calendar
tests/verify.js          engine checks (node)
tests/browser-check.py   Playwright checks that drive the real page
```

## Tests
```
node tests/verify.js                                  # 60 passed, 0 failed
python3 build.py && python3 tests/browser-check.py    # 36 passed, 0 failed
```
Saved runs: `tests/test-output.txt`, `tests/browser-output.txt`. Screenshots in `tests/`.

What the tests caught during the build:
- The company name ran into the next sentence ("Lakeshore Dental Group. We"). This was a logic bug, now fixed.
- A menu price from an attachment was read as the amount of a change request. This was a logic bug, now fixed.
- One browser test expected a meeting to be movable after the inbox run had already moved it. The test was wrong. The sample was changed to a meeting no inbox item touches.

## Extend it
- **Rules:** the categories, keywords and rules live in `data/inbox.json`.
- **Rules panel:** the page's panel changes the thresholds live.

A delivered version runs on n8n or Make:
- Claude does the reading and understanding.
- The rules, approval queue (Slack or email), retries, duplicate protection and masked logs work exactly as here.
- It connects to the client's own inbox, CRM, helpdesk, accounting and calendar through their APIs.

## Honest scope
- **Invented:** the agency, clients, messages, amounts, calendar and records.
- **Simulated in the browser:** every connected system. Nothing is emailed, posted, billed or paid.
- **No API key needed:** the understanding steps use rules rather than a language model.
- **Real:** the engine and the tests.
- **No client build** is shown or claimed.

Built by Taiwo, Pathfinder Automation Solutions.

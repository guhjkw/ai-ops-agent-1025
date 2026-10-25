/*
 * tests/verify.js
 * Node tests for src/agentEngine.js, the same file the page loads.
 * Run:  node tests/verify.js      (expects "0 failed" on the last line)
 */
'use strict';
const E = require('../src/agentEngine.js');
const raw = require('../data/inbox.json');
const { data, problems } = E.prepare(raw);

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS: ' + name); }
  else { failed++; console.log('FAIL: ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
const item = id => data.inbox.find(m => m.id === id);
function fresh() { return E.newState(data); }
function runAllFresh(rules) { const st = fresh(); const res = E.runAll(st, data.inbox, Object.assign({}, data.rules, rules || {})); return { st, res, by: id => res.find(r => r.item.id === id) }; }

console.log('1. Data check and helpers');
check('sample inbox loads with no problems', problems.length === 0, problems);
const bad = E.prepare(Object.assign({}, raw, { inbox: raw.inbox.concat([{ id: 'M-01', from: { email: 'x@y.example' }, body: 'dup id' }, { id: 'X', from: { email: 'not-an-email' }, body: 'hi' }, { id: 'Y', from: { email: 'a@b.example' }, body: '   ' }]) }));
check('bad rows (duplicate id, bad sender, empty body) are skipped and reported', bad.problems.length === 3 && bad.data.inbox.length === 12, bad.problems);
check('emails are masked in logs', E.redact('write to dana@lakeshoredental.example') === 'write to d***@lakeshoredental.example');
check('phone numbers are masked in logs', E.redact('call (503) 555-0148') === 'call (***) ***-0148');
check('card-like numbers are masked in logs', E.redact('card 4111 1111 1111 1234') === 'card ****-****-****-1234');
check('dates read naturally', E.niceDate('2026-10-30') === 'Friday, October 30' && E.clock(900) === '3 PM' && E.clock(630) === '10:30 AM');
const slots = E.callSlots(fresh(), 2);
check('call slots skip busy times and land on two different weekdays', slots.length === 2 && slots[0].label === 'Wednesday at 10 AM' && slots[1].label === 'Thursday at 10 AM', slots.map(s => s.label));
check('Saturday is never offered for a call', !E.isFree(fresh(), '2026-10-31', 600, 630));

console.log('2. Classifying the 12 inbound items');
const expect = { 'M-01': 'lead', 'M-02': 'lead', 'M-03': 'change_request', 'M-04': 'complaint', 'M-05': 'invoice', 'M-06': 'invoice', 'M-07': 'meeting', 'M-08': 'spam', 'M-09': 'lead', 'M-10': 'lead', 'M-11': 'phishing', 'M-12': 'refund' };
const st0 = fresh();
const cls = {};
data.inbox.forEach(m => { cls[m.id] = E.classify(m, st0); });
check('every item gets the expected category', Object.keys(expect).every(id => cls[id].category === expect[id]), Object.keys(expect).filter(id => cls[id].category !== expect[id]).map(id => [id, cls[id].category]));
check('clear items are confident (0.75 or more)', ['M-01', 'M-02', 'M-03', 'M-04', 'M-05', 'M-06', 'M-07', 'M-08', 'M-11', 'M-12'].every(id => cls[id].confidence >= 0.75), Object.fromEntries(Object.entries(cls).map(([k, v]) => [k, v.confidence])));
check('"pricing + our invoice was wrong" is flagged as two requests, low confidence', cls['M-10'].mixed && cls['M-10'].second === 'refund' && cls['M-10'].confidence < 0.7);
check('a client mentioning Google Ads is not treated as a new lead', cls['M-04'].scores.lead === 0);
check('a known vendor plus an invoice attachment is a bill', cls['M-05'].reasons.some(r => /known vendor/.test(r)) && cls['M-05'].reasons.some(r => /Invoice attached/.test(r)));
check('a login request on an outside link is phishing', cls['M-11'].reasons.some(r => /outside link/.test(r)));
check('a refund request that says "could you" is still a refund, not a change request', cls['M-12'].category === 'refund' && cls['M-12'].confidence >= 0.7);

console.log('3. Pulling out the details');
const ex = id => E.extract(item(id), cls[id], st0);
const f1 = ex('M-01');
check('lead: company, role, phone and budget per month', f1.company === 'Lakeshore Dental Group' && f1.role === 'Operations Director' && f1.phone === '(503) 555-0148' && f1.amount === 8000 && f1.period === 'month', f1);
check('lead: what they want and how big they are', JSON.stringify(f1.wants) === JSON.stringify(['New website', 'Google Ads management']) && f1.size === 'three offices', f1);
const f2 = ex('M-02');
check('website form: company and budget from the form fields', f2.company === 'Pinecrest Bakery' && f2.amount === 1500, f2);
const f3 = ex('M-03');
check('change request: two tasks and "by Friday" becomes Friday 30 Oct', f3.tasks.length === 2 && /^Swap the hero photo/.test(f3.tasks[0]) && /^Update the prices/.test(f3.tasks[1]) && f3.due === '2026-10-30', f3);
check('change request: a menu price in the attachment is not taken as an amount', f3.amount === undefined);
const f5 = ex('M-05');
check('bill: invoice number, total and due date (from the attachment)', f5.invoiceNo === 'INV-2207' && f5.amount === 2340 && f5.due === '2026-11-15', f5);
const f6 = ex('M-06');
check('receipt: "renews on November 1, 2026" becomes the due date', f6.amount === 49 && f6.invoiceNo === 'CNV-88213' && f6.due === '2026-11-01', f6);
const f7 = ex('M-07');
check('meeting: which call, from Friday to Thursday at 3 PM', f7.meeting && f7.meeting.fromDay === 5 && f7.meeting.toDay === 4 && f7.meeting.toTime === '15:00' && f7.meeting.what === 'strategy call', f7.meeting);
check('refund: the amount to refund', ex('M-12').refund === 600);

console.log('4. Decisions and actions on the whole inbox');
const A = runAllFresh();
const modes = id => A.by(id).actions.map(a => a.type + ':' + a.mode).join(',');
check('M-01: CRM record and alert happen now, the reply waits for approval', modes('M-01') === 'crm.create:auto,alert:auto,reply:approval' && A.by('M-01').status === 'needs_approval', modes('M-01'));
check('M-01: the $8,000/month deal is in the CRM', A.st.crm.deals.some(d => d.value === 8000 && d.period === 'month' && d.stage === 'New lead'));
check('M-01: the drafted reply offers the two real call slots', /Wednesday at 10 AM or Thursday at 10 AM/.test(A.st.approvals.find(a => a.item === 'M-01').payload.body));
check('M-02: small lead, no alert, reply waits for approval', modes('M-02') === 'crm.create:auto,reply:approval');
check('M-03: client change request becomes a ticket for Theo due Friday, acknowledgement sent', modes('M-03') === 'ticket:auto,reply:auto' && A.st.tickets.some(t => t.assignee === 'theo' && t.due === '2026-10-30') && A.by('M-03').status === 'done');
check('M-04: "we will cancel" goes to a person; the holding reply is only a draft', modes('M-04') === 'ticket:auto,alert:auto,escalate:human,reply:approval' && A.by('M-04').status === 'escalated');
check('M-04: no automated message reaches the unhappy client', !A.st.outbox.some(o => o.item === 'M-04'));
check('M-05: $2,340 bill is drafted and waits for Lena; the agent never pays', modes('M-05') === 'bill:approval' && A.st.bills.some(b => b.number === 'INV-2207' && b.status === 'waiting for approval'));
check('M-05: the accounting API failed once (429) and the agent retried', A.st.retries === 1 && A.by('M-05').trace.some(s => s.retried && /429/.test(s.out)));
check('M-06: the usual $49 receipt from a known vendor is approved by rule', modes('M-06') === 'bill:auto' && A.st.bills.some(b => b.number === 'CNV-88213' && b.status === 'approved by rule'));
const ev = A.st.calendar.events.find(e => e.id === 'E-4');
check('M-07: the strategy call moved to Thursday 3 PM and a confirmation went out', ev.date === '2026-10-29' && ev.start === '15:00' && ev.end === '16:00' && A.st.outbox.some(o => o.item === 'M-07' && /Thursday, October 29 at 3 PM/.test(o.body)));
check('M-08: the sales pitch is archived with no reply', modes('M-08') === 'archive:auto' && !A.st.outbox.some(o => o.item === 'M-08'));
check('M-09: the repeat form is merged: still one Pinecrest deal and one reply draft', A.st.crm.deals.filter(d => A.st.crm.companies.find(c => c.id === d.company && c.name === 'Pinecrest Bakery')).length === 1 && A.st.approvals.filter(a => /Marcus/.test(a.summary)).length === 1 && A.st.duplicates === 1);
check('M-10: two requests in one message go to a person, with the CRM mismatch noted', modes('M-10') === 'review:human' && /not in the CRM/.test(A.by('M-10').actions[0].summary));
check('M-11: phishing is quarantined, a security alert is raised, nothing is replied', modes('M-11') === 'quarantine:auto,alert:auto' && A.by('M-11').status === 'blocked' && A.st.quarantine.includes('M-11'));
check('M-12: the refund needs a person; a billing ticket is opened for Lena', modes('M-12') === 'ticket:auto,refund:approval' && A.st.tickets.some(t => t.assignee === 'lena'));
check('only client acknowledgements went out without a person (2 emails)', A.st.outbox.length === 2 && A.st.outbox.every(o => ['M-03', 'M-07'].includes(o.item)));
check('every step is in the trace, in order', A.by('M-01').trace.map(s => s.name).slice(0, 6).join('>') === 'Trigger>Read>Classify>Extract>Match>Decide' && A.by('M-01').trace.slice(-1)[0].name === 'Log');
check('logs never hold a full email address or phone number', A.res.every(r => r.trace.every(s => !/[a-z0-9]{2,}@/i.test(s.out) && !/555-01\d\d/.test(s.out.replace(/\*\*\*-01\d\d/g, '')))), A.res.flatMap(r => r.trace.filter(s => /[a-z0-9]{2,}@/i.test(s.out)).map(s => s.out)).slice(0, 2));

console.log('5. Running twice changes nothing (idempotent)');
const before = JSON.stringify([A.st.crm.deals.length, A.st.tickets.length, A.st.bills.length, A.st.outbox.length, A.st.approvals.length]);
const again = E.runAll(A.st, data.inbox, data.rules);
check('running the whole inbox again adds no records, emails or approvals', JSON.stringify([A.st.crm.deals.length, A.st.tickets.length, A.st.bills.length, A.st.outbox.length, A.st.approvals.length]) === before && again.every(r => r.repeat));

console.log('6. Approvals');
const B = runAllFresh();
const apLead = B.st.approvals.find(a => a.item === 'M-01');
let r = E.decideApproval(B.st, apLead.id, true);
check('approving the lead reply sends it (outbox +1) and closes M-01', r.ok && B.st.outbox.length === 3 && B.st.runs['M-01'].status === 'done');
r = E.decideApproval(B.st, apLead.id, true);
check('the same approval cannot be used twice', !r.ok && /already approved/.test(r.error));
const apBill = B.st.approvals.find(a => a.kind === 'bill');
E.decideApproval(B.st, apBill.id, false);
check('rejecting the bill marks it rejected and sends nothing', B.st.bills.find(b => b.id === apBill.billId).status === 'rejected' && B.st.outbox.length === 3);
const apRefund = B.st.approvals.find(a => a.kind === 'refund');
r = E.decideApproval(B.st, apRefund.id, true);
check('approving a refund never moves money: Lena issues it', r.ok && /Lena issues it/.test(r.result));
check('an unknown approval id is refused', !E.decideApproval(B.st, 'A-999', true).ok);

console.log('7. Your rules change what it does');
const C1 = runAllFresh({ autoReplyLeads: true });
check('lead replies on: the M-01 reply goes out without waiting', C1.by('M-01').actions.find(a => a.type === 'reply').mode === 'auto' && C1.st.outbox.some(o => o.item === 'M-01'));
const C2 = runAllFresh({ invoiceLimit: 5000 });
check('approval limit raised to $5,000: the $2,340 bill is approved by rule', C2.by('M-05').actions[0].mode === 'auto');
const C3 = runAllFresh({ escalateChurn: false });
check('churn escalation off: M-04 gets a reviewed apology instead of a hand-off', !C3.by('M-04').actions.some(a => a.type === 'escalate') && C3.by('M-04').status === 'needs_approval');
const C4 = runAllFresh({ confidence: 0.95 });
check('stricter confidence (0.95): more items go to a person', C4.res.filter(x => x.status === 'escalated').length > A.res.filter(x => x.status === 'escalated').length);
const C5 = runAllFresh({ simulateApiError: false });
check('simulated API error off: no retry', C5.st.retries === 0);
const C6 = runAllFresh({ highValueLead: 10000 });
check('high-value threshold $10,000: no alert for an $8,000/month lead', !C6.by('M-01').actions.some(a => a.type === 'alert'));

console.log('8. Messages the agent has never seen');
const st8 = fresh();
const mine = { id: 'NEW-1', channel: 'email', received: '2026-10-27T09:00', from: { name: 'Alex Rivera', email: 'alex@summitroof.example' }, subject: 'Quote for SEO', body: "Hi, I'm the owner at Summit Roofing. We need SEO and a new website, budget $3,000/month. Can we talk next week?" };
const r8 = E.run(st8, mine, data.rules);
check('a brand-new lead you type in is classified, extracted and put in the CRM', r8.classification.category === 'lead' && r8.fields.company === 'Summit Roofing' && r8.fields.amount === 3000 && st8.crm.deals.some(d => d.value === 3000));
const busyMove = { id: 'NEW-2', channel: 'email', received: '2026-10-27T09:05', from: { name: 'Hannah Cole', email: 'hannah@larkspurlegal.example' }, subject: 'Move the call?', body: "Could we move Friday's strategy call to Thursday at 2pm instead?" };
const r9 = E.run(fresh(), busyMove, data.rules);
check('moving a meeting onto a busy slot is refused and two free times are offered', r9.actions.length === 1 && r9.actions[0].type === 'reply' && r9.actions[0].mode === 'approval' && /already booked/.test(r9.actions[0].payload.body));
const r10 = E.run(fresh(), { id: 'NEW-3', channel: 'email', received: '2026-10-27T09:10', from: { name: 'Pat', email: 'pat@unknown.example' }, subject: 'hello', body: 'asdf qwerty' }, data.rules);
check('gibberish is never guessed at: a person reviews it', r10.actions[0].type === 'review' && r10.status === 'escalated');

console.log('9. Totals');
const mt = E.metrics(A.st, data.inbox.length);
check('totals: 12 processed, 6 handled alone, 5 waiting for you, 2 with a person', mt.processed === 12 && mt.autoHandled === 6 && mt.waiting === 5 && mt.escalated === 2, mt);
check('totals: 1 duplicate prevented, 1 retry, 1 blocked', mt.duplicates === 1 && mt.retries === 1 && mt.blocked === 1);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;

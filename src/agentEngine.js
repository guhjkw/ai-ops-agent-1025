/*
 * src/agentEngine.js
 * The logic behind the AI ops agent demo: read an inbound email or form, classify it, pull out the details,
 * check the CRM, decide what to do under the agency's rules, act (or queue it for a person), and log every step.
 * The page (index.html) and the tests (tests/verify.js) load this same file.
 *
 * Rule-based on purpose, so the demo runs with no API key. In a delivered build the "classify" and "extract"
 * steps call a language model (Claude) inside n8n or Make, and everything after them (the policy, the approval
 * queue, the retries, the logs) stays exactly as it is here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_RULES = {
    confidence: 0.7,        // below this, a person reviews the item
    autoReplyClients: true, // replies to existing clients go out on their own
    autoReplyLeads: false,  // replies to new leads wait for approval
    invoiceLimit: 500,      // bills above this need approval (bills are never paid by the agent)
    highValueLead: 5000,    // leads at or above this alert the account manager
    escalateChurn: true,    // "cancel", "terminate" from a client goes straight to a person
    simulateApiError: true  // the first accounting call fails once (429) to show the retry
  };
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  var STATUS = { done: 'Done', needs_approval: 'Waiting for you', escalated: 'Escalated', blocked: 'Blocked' };

  // ---------------------------------------------------------------- data check
  function prepare(raw) {
    var problems = [];
    var d = JSON.parse(JSON.stringify(raw || {}));
    var seen = {};
    d.inbox = (d.inbox || []).filter(function (m, i) {
      var ok = m && m.id && !seen[m.id] && m.from && /@/.test(m.from.email || '') && typeof m.body === 'string' && m.body.trim();
      if (!ok) problems.push('Inbox row ' + (i + 1) + ' skipped: needs a unique id, a sender email and a body');
      else seen[m.id] = true;
      return ok;
    });
    d.categories = d.categories || {};
    d.crm = d.crm || { companies: [], contacts: [], deals: [] };
    ['companies', 'contacts', 'deals'].forEach(function (k) { d.crm[k] = d.crm[k] || []; });
    d.helpdesk = d.helpdesk || { tickets: [] };
    d.accounting = d.accounting || { vendors: [], bills: [] };
    d.calendar = d.calendar || { hours: ['09:00', '17:30'], events: [] };
    d.rules = d.rules || {};
    if (!parseISO(d.now)) { problems.push('"now" is missing or not like 2026-10-27T08:30; using 2026-10-27T08:30'); d.now = '2026-10-27T08:30'; }
    return { data: d, problems: problems };
  }

  // ---------------------------------------------------------------- dates and text
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function parseISO(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(String(s || ''));
    if (!m) return null;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
    return isNaN(t) ? null : t;
  }
  function ymd(t) { var d = new Date(t); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function weekday(dateStr) { return new Date(parseISO(dateStr)).getUTCDay(); }
  function hm(s) { var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : NaN; }
  function hhmm(min) { return pad(Math.floor(min / 60)) + ':' + pad(min % 60); }
  function clock(min) { var h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12; return h12 + (m ? ':' + pad(m) : '') + ' ' + ap; }
  function niceDate(dateStr) { var t = new Date(parseISO(dateStr)); return DAYS[t.getUTCDay()] + ', ' + MONTHS[t.getUTCMonth()].charAt(0).toUpperCase() + MONTHS[t.getUTCMonth()].slice(1) + ' ' + t.getUTCDate(); }
  function nextWeekday(fromDate, wd, allowToday) {
    var t = parseISO(fromDate);
    for (var i = allowToday ? 0 : 1; i <= 7; i++) { var x = t + i * 86400000; if (new Date(x).getUTCDay() === wd) return ymd(x); }
    return null;
  }
  function norm(t) { return String(t == null ? '' : t).toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim(); }
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }
  function hasKw(n, kw) {
    var lead = /^[a-z0-9]/.test(kw) ? '(^|[^a-z0-9])' : '()';
    var tail = /[a-z0-9]$/.test(kw) ? '(?=$|[^a-z0-9])' : '';
    return new RegExp(lead + esc(kw) + tail).test(n);
  }
  function parseKw(k) { var p = String(k).split('|'); return { kw: p[0], w: p[1] ? +p[1] : (p[0].indexOf(' ') >= 0 ? 1.5 : 1) }; }
  function money(s) { return +String(s).replace(/[$,\s]/g, ''); }
  function fmtMoney(v) { return '$' + Math.round(v).toLocaleString('en-US'); }
  function first(name) { return String(name || '').split(' ')[0]; }

  // Masks personal data in logs: emails, phone numbers and long digit runs.
  function redact(t) {
    return String(t || '')
      .replace(/\b([a-z0-9._%+-])[a-z0-9._%+-]*@([a-z0-9.-]+\.[a-z]{2,})\b/gi, '$1***@$2')
      .replace(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?(\d{4})\b/g, '(***) ***-$1')
      .replace(/\b(\d{4})[\s-]?\d{4}[\s-]?\d{4}[\s-]?(\d{4})\b/g, '****-****-****-$2');
  }

  // ---------------------------------------------------------------- understanding
  function textOf(m) {
    return [m.subject || '', m.body || ''].concat((m.attachments || []).map(function (a) { return a.text || ''; })).join('\n');
  }
  function lookup(state, email) {
    email = String(email || '').toLowerCase();
    var dom = email.split('@')[1] || '';
    var contact = state.crm.contacts.filter(function (c) { return c.email.toLowerCase() === email; })[0] || null;
    var company = contact ? byId(state.crm.companies, contact.company) : state.crm.companies.filter(function (c) { return c.domain === dom; })[0] || null;
    var vendor = state.accounting.vendors.filter(function (v) { return v.domain === dom; })[0] || null;
    return { email: email, domain: dom, contact: contact, company: company, vendor: vendor, isClient: !!(company && company.status === 'client'), isOwn: dom === state.company.domain };
  }
  function byId(list, id) { return list.filter(function (x) { return x.id === id; })[0] || null; }

  function classify(m, state) {
    var n = norm(textOf(m)), who = lookup(state, m.from.email);
    var cats = state.categories, scores = {}, hits = {};
    Object.keys(cats).forEach(function (c) {
      scores[c] = 0; hits[c] = [];
      (cats[c].keywords || []).forEach(function (k) { var p = parseKw(k); if (hasKw(n, p.kw)) { scores[c] += p.w; hits[c].push(p.kw); } });
    });
    var reasons = [];
    function boost(c, v, why) { if (scores[c] == null) return; scores[c] = Math.max(0, scores[c] + v); if (why) reasons.push(why); }
    if (who.isClient) {
      ['change_request', 'complaint', 'meeting', 'refund'].forEach(function (c) { if (hits[c] && hits[c].length) boost(c, 0.5); });
      if (scores.lead) boost('lead', -1.5);
      reasons.push('Sender is a client: ' + who.company.name);
    } else if (!who.vendor && !who.contact) {
      if (hits.lead && hits.lead.length) boost('lead', 1, 'New sender, not in the CRM');
    }
    if (who.vendor) boost('invoice', 2, 'Sender is a known vendor: ' + who.vendor.name);
    if ((m.attachments || []).some(function (a) { return /inv|invoice|receipt/i.test(a.name || ''); })) boost('invoice', 2, 'Invoice attached');
    if (m.channel === 'form' && /budget\s*:/i.test(m.body)) boost('lead', 1.5, 'Website form with a budget');
    if (/\bcancel\b|\bterminate\b|\bend the contract\b/.test(n) && who.isClient) boost('complaint', 2, 'Cancellation language from a client');
    var links = (textOf(m).match(/https?:\/\/[^\s)]+/g) || []);
    var foreign = links.filter(function (u) { return u.indexOf(state.company.domain) < 0; });
    if (foreign.length && /password|sign-in|login|verify/.test(n)) boost('phishing', 2, 'Asks for a login on an outside link');
    var ranked = Object.keys(scores).sort(function (a, b) { return scores[b] - scores[a] || Object.keys(cats).indexOf(a) - Object.keys(cats).indexOf(b); });
    var top = ranked[0], second = ranked[1];
    var conf = scores[top] > 0 ? Math.min(0.99, scores[top] / (scores[top] + (scores[second] || 0) + 0.6)) : 0;
    var mixed = scores[second] >= 1.5 && scores[second] >= 0.6 * scores[top];
    if (hits[top] && hits[top].length) reasons.unshift('Matched: ' + hits[top].slice(0, 4).join(', '));
    return {
      category: scores[top] > 0 ? top : 'unknown', label: scores[top] > 0 ? cats[top].label : 'Unclear',
      confidence: Math.round(conf * 100) / 100, mixed: mixed, second: mixed ? second : null, secondLabel: mixed ? cats[second].label : null,
      scores: scores, reasons: reasons, who: who
    };
  }

  var SERVICES = [['new website', 'New website'], ['website', 'Website'], ['google ads', 'Google Ads management'], ['seo', 'SEO'], ['online ordering', 'Online ordering'], ['social media', 'Social media'], ['branding', 'Branding']];
  function extract(m, cls, state) {
    var raw = textOf(m), n = norm(raw), f = {};
    f.name = m.from.name; f.email = m.from.email.toLowerCase();
    var ph = /\(?\b([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})\b/.exec(raw);
    if (ph) f.phone = '(' + ph[1] + ') ' + ph[2] + '-' + ph[3];
    var comp = /^company:\s*(.+)$/im.exec(m.body) || /\b(?:director|manager|owner|founder|ceo|head of [a-z]+) at ([A-Z][\w&'-]*(?:[ \t]+(?:&[ \t]+)?[A-Z][\w&'-]*){0,4})/.exec(raw) || /,[ \t]*([A-Z][\w&'-]*(?:[ \t]+[A-Z][\w&'-]*){1,4})[ \t]*$/m.exec(m.body);
    if (comp) f.company = comp[1].trim().replace(/[.,]$/, '');
    else if (cls.who.company) f.company = cls.who.company.name;
    else if (cls.who.vendor) f.company = cls.who.vendor.name;
    var role = /\b(operations director|marketing director|office manager|owner|founder|ceo|general manager)\b/i.exec(raw);
    if (role) f.role = role[1].replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    var amounts = [], re = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)\s?(k\b)?(?:\s?(?:\/|per\s)\s?(month|mo|year|yr)\b)?/gi, a;
    while ((a = re.exec(raw))) amounts.push({ value: money(a[1]) * (a[2] ? 1000 : 1), period: a[3] ? (/^y/.test(a[3]) ? 'year' : 'month') : null, at: a.index });
    if (amounts.length && ['lead', 'invoice', 'refund'].indexOf(cls.category) >= 0 || amounts.length && cls.second === 'lead') {
      var pick = cls.category === 'invoice' ? amounts.filter(function (x) { return /total|amount|for \$|invoice/.test(raw.slice(Math.max(0, x.at - 30), x.at).toLowerCase()); })[0] || amounts[amounts.length - 1]
        : cls.category === 'lead' ? amounts.slice().sort(function (p, q) { return q.value - p.value; })[0] : amounts[0];
      f.amount = pick.value; if (pick.period) f.period = pick.period;
    }
    var inv = /\b((?:INV|CNV|BILL)-?\d{3,})\b/i.exec(raw);
    if (inv) f.invoiceNo = inv[1].toUpperCase();
    var iso = /\bdue\s+(\d{4}-\d{2}-\d{2})\b/i.exec(raw) || /\b(?:due|renews on)\s+([a-z]+ \d{1,2},? \d{4})/i.exec(raw);
    if (iso) f.due = /^\d{4}/.test(iso[1]) ? iso[1] : longDate(iso[1]);
    var by = /\bby (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.exec(n);
    if (by) f.due = nextWeekday(state.now.slice(0, 10), DAYS.map(function (d) { return d.toLowerCase(); }).indexOf(by[1]), false);
    if (cls.category === 'lead' || cls.second === 'lead') {
      var wants = [];
      SERVICES.forEach(function (s) { if (hasKw(n, s[0]) && !(s[0] === 'website' && wants.indexOf('New website') >= 0)) wants.push(s[1]); });
      if (wants.length) f.wants = wants;
      var offices = /\b(three|two|four|five|\d+) (offices|locations|stores|clinics)\b/.exec(n);
      if (offices) f.size = offices[1] + ' ' + offices[2];
    }
    if (cls.category === 'change_request') {
      f.tasks = String(m.body).split(/(?<=[.?!])\s+|\band\b/).map(function (s) { var x = s.trim(), y; do { y = x; x = x.replace(/^(hi \w+,|hello \w+,|could you|can you|please)\s*/i, '').trim(); } while (x !== y); return x.replace(/[?.!]+$/, ''); })
        .filter(function (s) { return /^(swap|update|change|replace|add|remove|fix)\b/i.test(s); })
        .map(function (s) { return s.charAt(0).toUpperCase() + s.slice(1); });
    }
    if (cls.category === 'meeting') {
      var mv = /move (\w+)'s ([a-z ]+?) (?:to|for) (\w+)(?: at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/.exec(n);
      if (mv) {
        var fromWd = DAYS.map(function (d) { return d.toLowerCase(); }).indexOf(mv[1]), toWd = DAYS.map(function (d) { return d.toLowerCase(); }).indexOf(mv[3]);
        var h = mv[4] ? +mv[4] : null; if (h != null && (mv[6] === 'pm' || (!mv[6] && h < 8)) && h < 12) h += 12;
        f.meeting = { fromDay: fromWd, what: mv[2].trim(), toDay: toWd, toTime: h != null ? hhmm(h * 60 + (+mv[5] || 0)) : null };
      }
    }
    if (cls.category === 'refund' && f.amount) f.refund = f.amount;
    return f;
  }
  function longDate(s) {
    var m = /([a-z]+) (\d{1,2}),? (\d{4})/i.exec(s);
    if (!m) return null;
    var mi = MONTHS.indexOf(m[1].toLowerCase()); if (mi < 0) return null;
    return m[3] + '-' + pad(mi + 1) + '-' + pad(+m[2]);
  }

  // ---------------------------------------------------------------- calendar
  function busy(state, date) { return state.calendar.events.filter(function (e) { return e.date === date; }); }
  function isFree(state, date, start, end, ignoreId) {
    if (weekday(date) === 0 || weekday(date) === 6) return false;
    var h = state.calendar.hours; if (start < hm(h[0]) || end > hm(h[1])) return false;
    return !busy(state, date).some(function (e) { return e.id !== ignoreId && start < hm(e.end) && hm(e.start) < end; });
  }
  // Two 30-minute call slots on different upcoming weekdays, 10 AM to 4 PM, never on top of an event.
  function callSlots(state, count) {
    var out = [], t = parseISO(state.now.slice(0, 10));
    for (var d = 1; d <= 10 && out.length < (count || 2); d++) {
      var date = ymd(t + d * 86400000);
      for (var s = 600; s <= 930; s += 30) if (isFree(state, date, s, s + 30)) { out.push({ date: date, start: s, label: DAYS[weekday(date)] + ' at ' + clock(s) }); break; }
    }
    return out;
  }

  // ---------------------------------------------------------------- deciding
  function decide(m, cls, f, state, rules) {
    var acts = [], c = cls.category, who = cls.who, own = state.company;
    function add(type, mode, summary, why, payload) { acts.push({ type: type, mode: mode, summary: summary, why: why, payload: payload || {} }); }
    if (c === 'phishing') {
      add('quarantine', 'auto', 'Quarantine the message. No links opened, nothing replied', 'Phishing is blocked automatically');
      add('alert', 'auto', 'Alert Sam: phishing attempt from ' + who.domain, 'Security alerts go to the founder', { to: 'sam', level: 'security' });
      return acts;
    }
    if (c === 'spam') { add('archive', 'auto', 'Archive. No reply', 'Sales pitches are archived'); return acts; }
    if (c === 'unknown' || cls.confidence < rules.confidence || cls.mixed) {
      var why = cls.mixed ? 'Two requests in one message (' + cls.label + ' and ' + cls.secondLabel + ')' : 'Confidence ' + cls.confidence + ' is under the ' + rules.confidence + ' rule';
      var note = !who.contact && !who.company && /\b(our|my) (last )?invoice\b/.test(norm(m.body)) ? ' Says "our last invoice" but the sender is not in the CRM.' : '';
      add('review', 'human', 'A person reviews it.' + note + ' Suggested: ' + cls.label + (cls.secondLabel ? ' + ' + cls.secondLabel : ''), why, { suggested: [cls.category, cls.second].filter(Boolean) });
      return acts;
    }
    if (c === 'lead') {
      var dup = state.leadsByEmail[f.email];
      if (dup) { add('crm.merge', 'auto', 'Duplicate of ' + dup.itemId + ': add a note to deal ' + dup.dealId + ', no second record, no second reply', 'Same sender and request within 24 hours', { dealId: dup.dealId, of: dup.itemId }); return acts; }
      var monthly = f.amount ? f.amount : null;
      add('crm.create', 'auto', 'Create ' + (f.company || f.name) + ' with contact ' + f.name + ' and a deal' + (monthly ? ' worth ' + fmtMoney(monthly) + (f.period === 'month' ? '/month' : '') : ''), 'New leads always go into the CRM', { company: f.company || f.name, value: monthly, period: f.period || null });
      if (monthly && monthly >= rules.highValueLead) add('alert', 'auto', 'Alert Priya: high-value lead (' + fmtMoney(monthly) + (f.period === 'month' ? '/month' : '') + ')', 'Leads at or above ' + fmtMoney(rules.highValueLead) + ' alert the account manager', { to: 'priya', level: 'lead' });
      var slots = callSlots(state, 2);
      var body = 'Hi ' + first(f.name) + ',\n\nThanks for reaching out' + (f.wants ? ' about ' + listText(f.wants.map(phrase)) : '') + (f.company ? ' for ' + f.company : '') + '. ' +
        (slots.length === 2 ? 'Could we talk on ' + slots[0].label + ' or ' + slots[1].label + '? The call takes 30 minutes.' : 'When suits you for a 30-minute call?') + '\n\nBest,\n' + own.signoff;
      add('reply', rules.autoReplyLeads ? 'auto' : 'approval', 'Reply to ' + f.name + (slots.length === 2 ? ' offering ' + slots[0].label + ' or ' + slots[1].label : ''), rules.autoReplyLeads ? 'Lead replies go out on their own (rule on)' : 'Replies to new leads wait for approval (rule off)', { to: f.email, subject: 'Re: ' + m.subject, body: body });
      return acts;
    }
    if (c === 'change_request') {
      var owner = 'theo', due = f.due;
      add('ticket', 'auto', 'Ticket for Theo: ' + (f.tasks && f.tasks.length ? f.tasks.join('; ') : m.subject) + (due ? ', due ' + niceDate(due) : ''), 'Client change requests become tickets', { title: m.subject + (who.company ? ' · ' + who.company.name : ''), assignee: owner, priority: 'normal', due: due, company: who.company && who.company.id, tasks: f.tasks || [] });
      var ack = 'Hi ' + first(f.name) + ',\n\nGot it: ' + (f.tasks && f.tasks.length ? listText(f.tasks.map(lowerFirst)) : 'your request') + (due ? ', live by ' + niceDate(due) : '') + '. Theo has the ticket and will confirm when it is done.\n\nBest,\n' + own.signoff;
      add('reply', rules.autoReplyClients ? 'auto' : 'approval', 'Acknowledge to ' + f.name, rules.autoReplyClients ? 'Client acknowledgements go out on their own' : 'Client replies wait for approval (rule off)', { to: f.email, subject: 'Re: ' + m.subject, body: ack });
      return acts;
    }
    if (c === 'complaint') {
      var churn = /\bcancel\b|\bterminate\b|\bend the contract\b/.test(norm(m.body));
      add('ticket', 'auto', 'Urgent ticket for Priya: ' + m.subject, 'Complaints are always ticketed', { title: m.subject + (who.company ? ' · ' + who.company.name : ''), assignee: 'priya', priority: 'urgent', company: who.company && who.company.id });
      if (churn && rules.escalateChurn) {
        add('alert', 'auto', 'Alert Priya and Sam now: ' + (who.company ? who.company.name : f.name) + ' may cancel', 'Cancellation language goes straight to a person', { to: 'priya,sam', level: 'urgent' });
        add('escalate', 'human', 'A person calls ' + f.name + ' today. No automated reply', 'An unhappy client gets a human, not a bot');
        add('reply', 'approval', 'Holding reply drafted for Priya to send', 'Drafted only. A person decides what to say', { to: f.email, subject: 'Re: ' + m.subject, body: 'Hi ' + first(f.name) + ',\n\nYou are right to flag this, and I am sorry nobody told you. Priya is looking at the paused ads now and will call you within the hour.\n\nSam' });
      } else {
        add('reply', 'approval', 'Apology drafted for Priya to send', 'Complaint replies are always reviewed', { to: f.email, subject: 'Re: ' + m.subject, body: 'Hi ' + first(f.name) + ',\n\nThank you for telling us. Priya is looking into it now and will update you today.\n\nSam' });
      }
      return acts;
    }
    if (c === 'invoice') {
      var vendor = who.vendor;
      var under = f.amount != null && f.amount <= rules.invoiceLimit, usual = vendor && vendor.recurring && vendor.usual && Math.abs(f.amount - vendor.usual) < 0.01;
      var mode = under || usual ? 'auto' : 'approval';
      if (state.bills.some(function (b) { return b.number === f.invoiceNo && f.invoiceNo; })) { add('archive', 'auto', 'Already have bill ' + f.invoiceNo + '. Archived as a duplicate', 'Bills are matched by invoice number'); return acts; }
      add('bill', mode, 'Draft bill ' + (f.invoiceNo || '') + ' from ' + (vendor ? vendor.name : f.name) + ' for ' + (f.amount != null ? fmtMoney2(f.amount) : 'an unknown amount') + (f.due ? ', due ' + niceDate(f.due) : '') + (mode === 'auto' ? ', approved by rule' : ', waiting for Lena'),
        mode === 'auto' ? (usual ? 'Known recurring amount from a known vendor' : 'Under the ' + fmtMoney(rules.invoiceLimit) + ' approval limit') : 'Over the ' + fmtMoney(rules.invoiceLimit) + ' limit: Lena approves. The agent never pays bills',
        { vendor: vendor ? vendor.id : null, vendorName: vendor ? vendor.name : f.name, number: f.invoiceNo || null, amount: f.amount, due: f.due || null });
      return acts;
    }
    if (c === 'meeting') {
      var mt = f.meeting, ev = null, target = null;
      if (mt && mt.fromDay >= 0) {
        var fromDate = nextWeekday(state.now.slice(0, 10), mt.fromDay, true);
        ev = state.calendar.events.filter(function (e) { return e.date === fromDate && (who.company && e.company === who.company.id || norm(e.title).indexOf(mt.what.split(' ')[0]) >= 0); })[0] || null;
      }
      if (ev && mt.toDay >= 0 && mt.toTime) {
        var toDate = nextWeekday(state.now.slice(0, 10), mt.toDay, true), len = hm(ev.end) - hm(ev.start), st = hm(mt.toTime);
        target = { date: toDate, start: st, end: st + len };
        if (isFree(state, toDate, st, st + len, ev.id)) {
          add('calendar.move', who.isClient ? 'auto' : 'approval', 'Move "' + ev.title + '" to ' + niceDate(toDate) + ' at ' + clock(st), 'The new time is free, and the request is from the client on the invite', { eventId: ev.id, date: toDate, start: hhmm(st), end: hhmm(st + len) });
          add('reply', rules.autoReplyClients ? 'auto' : 'approval', 'Confirm the new time to ' + f.name, 'Client confirmations go out on their own', { to: f.email, subject: 'Re: ' + m.subject, body: 'Hi ' + first(f.name) + ',\n\nNo problem. Our ' + mt.what + ' is now ' + niceDate(toDate) + ' at ' + clock(st) + '. The invite has been updated.\n\nBest,\n' + own.signoff });
        } else {
          var alts = callSlots(state, 2);
          add('reply', 'approval', 'That time is taken: offer ' + alts.map(function (s) { return s.label; }).join(' or '), 'The calendar is never double-booked', { to: f.email, subject: 'Re: ' + m.subject, body: 'Hi ' + first(f.name) + ',\n\nThat time is already booked. Would ' + alts.map(function (s) { return s.label; }).join(' or ') + ' work instead?\n\nBest,\n' + own.signoff });
        }
      } else add('review', 'human', 'Could not find which meeting to move. A person checks the calendar', 'No matching event');
      return acts;
    }
    if (c === 'refund') {
      add('ticket', 'auto', 'Billing ticket for Lena: ' + m.subject, 'Billing questions become tickets', { title: m.subject + (who.company ? ' · ' + who.company.name : ''), assignee: 'lena', priority: 'high', company: who.company && who.company.id });
      add('refund', 'approval', 'Refund ' + (f.refund ? fmtMoney2(f.refund) : 'amount to check') + ' to ' + (who.company ? who.company.name : f.name) + ' (' + (/twice|double/.test(norm(m.body)) ? 'charged twice' : 'refund request') + ')', 'Refunds always need a person. The agent never moves money', { amount: f.refund || null, company: who.company && who.company.id });
      return acts;
    }
    add('review', 'human', 'A person reviews it', 'No rule for this kind of message');
    return acts;
  }
  function fmtMoney2(v) { return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
  var PHRASES = { 'New website': 'a new website', 'Website': 'a website', 'Google Ads management': 'Google Ads management', 'SEO': 'SEO', 'Online ordering': 'online ordering', 'Social media': 'social media', 'Branding': 'branding' };
  function phrase(s) { return PHRASES[s] || lowerFirst(s); }
  function lowerFirst(s) { return String(s).replace(/^([A-Z])([a-z])/, function (x, a, b) { return a.toLowerCase() + b; }); }
  function listText(a) { return a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }

  // ---------------------------------------------------------------- acting
  function newState(data) {
    var d = JSON.parse(JSON.stringify(data));
    return {
      now: d.now, company: d.company, categories: d.categories, team: d.team || [],
      crm: d.crm, tickets: d.helpdesk.tickets, accounting: d.accounting, bills: d.accounting.bills, calendar: d.calendar,
      alerts: [], outbox: [], archive: [], quarantine: [], approvals: [], log: [], runs: {}, leadsByEmail: {},
      seq: { D: 104, T: 202, B: 302, A: 1, C: 4, P: 4 }, apiFailedOnce: false, retries: 0, duplicates: 0
    };
  }
  function nextId(state, k) { return k + '-' + (state.seq[k]++); }

  // Runs one inbound item end to end and returns the trace the page draws. Running the same item twice does nothing new.
  function runItem(state, m, rulesIn) {
    var rules = {}, k;
    for (k in DEFAULT_RULES) rules[k] = DEFAULT_RULES[k];
    for (k in (rulesIn || {})) rules[k] = rulesIn[k];
    if (state.runs[m.id]) return { item: m, trace: state.runs[m.id].trace, status: state.runs[m.id].status, repeat: true, actions: state.runs[m.id].actions };
    var trace = [], t = 0;
    function step(name, ms, out, extra) { t += ms; var s = { name: name, ms: ms, at: t, out: out }; for (var x in (extra || {})) s[x] = extra[x]; trace.push(s); return s; }
    step('Trigger', 4, (m.channel === 'form' ? 'Website form' : 'Email') + ' received ' + m.received.slice(11) + ' from ' + redact(m.from.email));
    step('Read', 35 + 15 * (m.attachments || []).length, 'Subject "' + m.subject + '"' + ((m.attachments || []).length ? ', ' + m.attachments.length + ' attachment' + (m.attachments.length > 1 ? 's' : '') + ' read (' + m.attachments.map(function (a) { return a.name; }).join(', ') + ')' : ''));
    var cls = classify(m, state);
    step('Classify', 240, cls.label + (cls.mixed ? ' + ' + cls.secondLabel : '') + ' · confidence ' + cls.confidence.toFixed(2), { reasons: cls.reasons, category: cls.category, confidence: cls.confidence, mixed: cls.mixed });
    var f = extract(m, cls, state);
    step('Extract', 190, Object.keys(f).filter(function (x) { return ['email', 'tasks', 'meeting', 'wants', 'period', 'refund'].indexOf(x) < 0; }).map(function (x) { return x + ': ' + (x === 'amount' ? fmtMoney2(f[x]) + (f.period ? '/' + f.period : '') : x === 'phone' ? redact(f[x]) : f[x]); }).join(' · '), { fields: f });
    var who = cls.who;
    step('Match', 60, who.contact ? 'Found ' + who.contact.name + ' at ' + who.company.name + ' (' + who.company.status + ')' : who.company ? 'Known company ' + who.company.name + ', new contact' : who.vendor ? 'Known vendor ' + who.vendor.name : state.leadsByEmail[f.email] ? 'Seen earlier today in ' + state.leadsByEmail[f.email].itemId : 'Not in the CRM: new');
    var acts = decide(m, cls, f, state, rules);
    step('Decide', 12, acts.map(function (a) { return (a.mode === 'auto' ? 'Do: ' : a.mode === 'approval' ? 'Ask you: ' : 'Hand to a person: ') + a.summary; }).join(' | '), { actions: acts });
    acts.forEach(function (a) { act(state, m, a, rules, step, f); });
    var status = acts.some(function (a) { return a.mode === 'human'; }) ? 'escalated' : acts.some(function (a) { return a.mode === 'approval'; }) ? 'needs_approval' : acts.some(function (a) { return a.type === 'quarantine'; }) ? 'blocked' : 'done';
    step('Log', 8, 'Saved with personal details masked: ' + redact(m.from.email) + (f.phone ? ', ' + redact(f.phone) : ''));
    state.log.push({ item: m.id, status: status, category: cls.category, at: m.received, ms: t });
    state.runs[m.id] = { trace: trace, status: status, actions: acts, category: cls.category, label: cls.label, fields: f, confidence: cls.confidence };
    return { item: m, trace: trace, status: status, actions: acts, classification: cls, fields: f, totalMs: t };
  }

  function act(state, m, a, rules, step, f) {
    var p = a.payload, res;
    if (a.mode === 'approval' || a.mode === 'human') {
      var ap = { id: nextId(state, 'A'), item: m.id, kind: a.type, mode: a.mode, summary: a.summary, why: a.why, payload: p, status: 'pending' };
      if (a.type === 'bill') { res = createBill(state, p, 'waiting for approval', step); ap.billId = res.id; }
      state.approvals.push(ap);
      step(a.mode === 'human' ? 'Hand off' : 'Approval', 6, (a.mode === 'human' ? 'Waiting for a person: ' : 'Queued for you (' + ap.id + '): ') + a.summary, { mode: a.mode });
      return;
    }
    switch (a.type) {
      case 'crm.create': {
        var co = { id: nextId(state, 'C'), name: p.company, domain: f.email.split('@')[1], status: 'prospect', owner: 'priya' };
        var ct = { id: nextId(state, 'P'), name: f.name, email: f.email, company: co.id, phone: f.phone || null };
        var dl = { id: nextId(state, 'D'), company: co.id, name: (f.wants ? f.wants.join(' + ') : 'New enquiry'), value: p.value || null, period: p.period, stage: 'New lead', source: m.channel };
        state.crm.companies.push(co); state.crm.contacts.push(ct); state.crm.deals.push(dl);
        state.leadsByEmail[f.email] = { itemId: m.id, dealId: dl.id };
        step('CRM', 140, 'Created ' + co.name + ', contact ' + ct.name + ', deal ' + dl.id + (dl.value ? ' (' + fmtMoney(dl.value) + (dl.period === 'month' ? '/month' : '') + ')' : ''), { system: 'crm' });
        break;
      }
      case 'crm.merge': {
        var deal = byId(state.crm.deals, p.dealId);
        if (deal) { deal.notes = (deal.notes || []).concat(['Sent the form again at ' + m.received.slice(11)]); }
        state.duplicates++;
        step('CRM', 90, 'Duplicate merged into ' + p.dealId + '. No new record, no second reply', { system: 'crm' });
        break;
      }
      case 'ticket': {
        var tk = { id: nextId(state, 'T'), title: p.title, assignee: p.assignee, priority: p.priority, due: p.due || null, status: 'open', company: p.company || null, tasks: p.tasks || [], item: m.id };
        state.tickets.push(tk);
        step('Helpdesk', 120, 'Opened ' + tk.id + ' for ' + cap(p.assignee) + ' (' + p.priority + ')' + (tk.due ? ', due ' + niceDate(tk.due) : ''), { system: 'helpdesk' });
        break;
      }
      case 'reply': {
        state.outbox.push({ to: p.to, subject: p.subject, body: p.body, item: m.id, sentBy: 'agent', at: m.received });
        step('Email', 180, 'Sent "' + p.subject + '" to ' + redact(p.to), { system: 'email' });
        break;
      }
      case 'alert': {
        state.alerts.push({ to: p.to, level: p.level, text: a.summary, item: m.id });
        step('Slack', 70, 'Posted to #ops for ' + p.to.split(',').map(cap).join(' and ') + ': ' + a.summary.replace(/^Alert [^:]+: /, ''), { system: 'slack' });
        break;
      }
      case 'bill': createBill(state, p, 'approved by rule', step); break;
      case 'calendar.move': {
        var ev = byId(state.calendar.events, p.eventId);
        var was = niceDate(ev.date) + ' at ' + clock(hm(ev.start));
        ev.date = p.date; ev.start = p.start; ev.end = p.end; ev.moved = true;
        step('Calendar', 110, 'Moved "' + ev.title + '" from ' + was + ' to ' + niceDate(p.date) + ' at ' + clock(hm(p.start)) + '. Invite updated', { system: 'calendar' });
        break;
      }
      case 'archive': state.archive.push(m.id); step('Email', 20, 'Archived', { system: 'email' }); break;
      case 'quarantine': state.quarantine.push(m.id); step('Security', 30, 'Quarantined. Links disabled', { system: 'security' }); break;
    }
  }
  function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
  function createBill(state, p, status, step) {
    var ms = 160, extra = '';
    if (state.rulesSimError !== false && !state.apiFailedOnce && state._simErr) {
      state.apiFailedOnce = true; state.retries++; ms += 2000;
      extra = 'Accounting API answered 429 (rate limit). Waited 2 s and retried. ';
    }
    var b = { id: nextId(state, 'B'), vendor: p.vendor, vendorName: p.vendorName, number: p.number, amount: p.amount, due: p.due, status: status };
    state.bills.push(b);
    step('Accounting', ms, extra + 'Drafted bill ' + b.id + (b.number ? ' (' + b.number + ')' : '') + ' for ' + fmtMoney2(b.amount) + ', ' + status, { system: 'accounting', retried: !!extra });
    return b;
  }

  function runAll(state, items, rules) {
    state._simErr = (rules && rules.simulateApiError != null) ? rules.simulateApiError : DEFAULT_RULES.simulateApiError;
    return items.map(function (m) { return runItem(state, m, rules); });
  }
  function run(state, m, rules) {
    state._simErr = (rules && rules.simulateApiError != null) ? rules.simulateApiError : DEFAULT_RULES.simulateApiError;
    return runItem(state, m, rules);
  }

  // A person decides on a queued item. Approving does the action; rejecting records the decision. Nothing happens twice.
  function decideApproval(state, id, approve) {
    var ap = byId(state.approvals, id);
    if (!ap) return { ok: false, error: 'No approval ' + id };
    if (ap.status !== 'pending') return { ok: false, error: id + ' was already ' + ap.status };
    ap.status = approve ? 'approved' : 'rejected';
    var p = ap.payload, did;
    if (approve) {
      if (ap.kind === 'reply') { state.outbox.push({ to: p.to, subject: p.subject, body: p.body, item: ap.item, sentBy: 'you' }); did = 'Sent "' + p.subject + '"'; }
      else if (ap.kind === 'bill') { var b = byId(state.bills, ap.billId); if (b) b.status = 'approved for the payment run'; did = 'Bill approved for the payment run (still paid by Lena, not the agent)'; }
      else if (ap.kind === 'refund') { did = 'Refund approved. Lena issues it from the bank, not the agent'; }
      else if (ap.kind === 'calendar.move') { var ev = byId(state.calendar.events, p.eventId); ev.date = p.date; ev.start = p.start; ev.end = p.end; did = 'Meeting moved'; }
      else did = 'Marked as handled';
    } else {
      if (ap.kind === 'bill') { var bb = byId(state.bills, ap.billId); if (bb) bb.status = 'rejected'; }
      did = 'Rejected. Nothing sent';
    }
    ap.result = did;
    var left = state.approvals.filter(function (x) { return x.item === ap.item && x.status === 'pending'; }).length;
    if (!left && state.runs[ap.item]) state.runs[ap.item].status = state.runs[ap.item].status === 'escalated' ? 'escalated' : 'done';
    return { ok: true, approval: ap, result: did };
  }

  function metrics(state, total) {
    var runs = Object.keys(state.runs).map(function (k) { return state.runs[k]; });
    var by = function (s) { return runs.filter(function (r) { return r.status === s; }).length; };
    return {
      inbox: total, processed: runs.length,
      autoHandled: by('done') + by('blocked'), waiting: state.approvals.filter(function (a) { return a.status === 'pending' && a.mode === 'approval'; }).length,
      escalated: by('escalated'), blocked: by('blocked'), duplicates: state.duplicates, retries: state.retries,
      sent: state.outbox.length, tickets: state.tickets.length, deals: state.crm.deals.length
    };
  }

  return {
    DEFAULT_RULES: DEFAULT_RULES, STATUS: STATUS,
    prepare: prepare, newState: newState, classify: classify, extract: extract, decide: decide,
    run: run, runAll: runAll, decideApproval: decideApproval, metrics: metrics,
    redact: redact, callSlots: callSlots, isFree: isFree, niceDate: niceDate, clock: clock, hm: hm, lookup: lookup, textOf: textOf
  };
});

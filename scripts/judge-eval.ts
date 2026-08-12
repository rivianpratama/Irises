// Judge accuracy harness. Runs judgeEmail over a labeled fixture set of synthetic
// real-estate emails and reports precision/recall on `important`, fraud detection,
// and severity agreement. Run it before/after any judge persona edit:
//
//   npx tsx scripts/judge-eval.ts
//
// Needs the same LLM keys as the app (.env is loaded). Spends ~20 classify-tier
// calls per run. This is a manual regression harness, not a CI test.
import '../src/loadEnv.js';
import { judgeEmail } from '../src/agents/judge/client.js';
import type { DealEmail } from '../src/services/gmail.js';
import type { JudgeSeverity } from '../src/agents/judge/client.js';

interface EvalCase {
  label: string;
  expectImportant: boolean;
  expectFraud?: boolean;
  expectSeverity?: JudgeSeverity[]; // acceptable severities when important
  email: Pick<DealEmail, 'from' | 'subject' | 'snippet' | 'bodyText'>;
}

function toDealEmail(c: EvalCase, i: number): DealEmail {
  return {
    id: `eval-${i}`, threadId: `thread-${i}`,
    from: c.email.from, to: ['agent@example.com'],
    date: new Date().toUTCString(), internalDate: Date.now(),
    subject: c.email.subject, snippet: c.email.snippet,
    bodyText: c.email.bodyText, attachments: [], labelIds: ['INBOX', 'UNREAD'],
  };
}

const CASES: EvalCase[] = [
  // --- should flag ---------------------------------------------------------
  {
    label: 'inspection contingency expiring in 3 days', expectImportant: true, expectSeverity: ['critical', 'high'],
    email: { from: 'coordinator@titleco.com', subject: 'Inspection contingency deadline - 412 Maple St',
      snippet: 'Reminder: the inspection contingency on 412 Maple St expires', bodyText: 'Reminder: the inspection contingency on 412 Maple St expires this Friday at 5:00 PM. Please advise whether your buyer intends to proceed, renegotiate, or terminate.' },
  },
  {
    label: 'changed wiring instructions (fraud)', expectImportant: true, expectFraud: true, expectSeverity: ['critical'],
    email: { from: 'closing@firstamerlcan-title.com', subject: 'UPDATED wire instructions for closing - send today',
      snippet: 'Our account details have changed. Please wire closing funds', bodyText: 'Please note our account details have changed effective today. Wire the closing funds to the NEW account below before 3pm to avoid delaying your closing. Account: 445529871, Routing: 021000021. Do not call the office as our phones are down, reply to this email instead.' },
  },
  {
    label: 'counteroffer expiring tomorrow', expectImportant: true, expectSeverity: ['critical', 'high'],
    email: { from: 'lisa.tran@brightrealty.com', subject: 'Counter on 88 Birch Ln - response needed by tomorrow 5pm',
      snippet: 'Sellers countered at $487,500', bodyText: 'Hi, sellers have countered at $487,500 with a 30-day close and the washer/dryer excluded. This counter expires tomorrow at 5pm. Let me know how your buyers want to respond.' },
  },
  {
    label: 'appraisal under contract price', expectImportant: true, expectSeverity: ['high', 'critical'],
    email: { from: 'orders@appraisalworks.com', subject: 'Appraisal completed - 201 Cedar Ave',
      snippet: 'The appraisal for 201 Cedar Ave has been completed', bodyText: 'The appraisal for 201 Cedar Ave has been completed. Appraised value: $438,000. We note the contract price of $455,000. The full report is attached for your review.' },
  },
  {
    label: 'lender document request', expectImportant: true, expectSeverity: ['high', 'medium'],
    email: { from: 'jmorales@homelend.com', subject: 'Docs needed to keep the Johnson loan on track',
      snippet: 'We still need updated pay stubs', bodyText: 'To keep the Johnson file moving we still need: two most recent pay stubs, the signed 4506-C, and the updated bank statement. Underwriting wants these by Wednesday to hold the closing date.' },
  },
  {
    label: 'inspection report with repair items', expectImportant: true, expectSeverity: ['high', 'medium'],
    email: { from: 'reports@hawkeyeinspections.com', subject: 'Inspection report - 745 Pine St',
      snippet: 'Your inspection report is ready', bodyText: 'The inspection at 745 Pine St is complete. Notable items: the roof shows significant granule loss and two damaged shingles, the water heater (2011) is at end of life, and there is evidence of moisture in the basement SW corner. Full report attached.' },
  },
  {
    // critical is acceptable: the CD carries a hard federal 3-business-day signing deadline.
    label: 'closing disclosure to sign', expectImportant: true, expectSeverity: ['critical', 'high', 'medium'],
    email: { from: 'docs@sunrisetitle.com', subject: 'Closing Disclosure ready for signature - Reynolds',
      snippet: 'The Closing Disclosure for the Reynolds purchase', bodyText: 'The Closing Disclosure for the Reynolds purchase is ready for signature. Federal rules require it signed at least 3 business days before closing (scheduled July 10). Please have your buyer review and sign at the link in the attached document.' },
  },
  {
    label: 'named lead with specific ask', expectImportant: true, expectSeverity: ['high', 'medium'],
    email: { from: 'leads@homesearchpro.com', subject: 'New inquiry: Dana Whitfield re: 88 Birch Ln',
      snippet: 'Dana Whitfield is interested in 88 Birch Ln', bodyText: 'New inquiry from Dana Whitfield (pre-approved, $450k budget): "We drove past 88 Birch Ln and love it. Could we see it this weekend? We are ready to move quickly." Contact: 512-555-0188, dana.whitfield@gmail.com.' },
  },
  {
    label: 'client waiting on an answer', expectImportant: true, expectSeverity: ['high', 'medium'],
    email: { from: 'mike.henderson@gmail.com', subject: 'Re: roof repair - any word?',
      snippet: 'still waiting to hear back on the roof', bodyText: 'Hey, just checking in again. Still waiting to hear whether the sellers will fix the roof before we sign off on the inspection. We are getting a little nervous about the timeline. Anything?' },
  },
  {
    label: 'showing request', expectImportant: true, expectSeverity: ['medium', 'high'],
    email: { from: 'showings@showingtime.com', subject: 'Showing request - 55 Cedar St, Sat 2:00pm',
      snippet: 'A buyer agent has requested a showing', bodyText: 'Agent Priya Nair (Keller Group) has requested a showing at your listing 55 Cedar St for Saturday 2:00-2:30pm. Please confirm or propose a new time.' },
  },
  // --- should stay silent --------------------------------------------------
  {
    label: 'staging tips newsletter', expectImportant: false,
    email: { from: 'newsletter@realtytips.com', subject: 'This week: 5 staging tips that sell homes fast',
      snippet: 'Five staging tips plus our weekly market roundup', bodyText: 'This week in real estate: 5 staging secrets, why spring listings pop, and our market roundup. Read more on our blog. Unsubscribe at any time.' },
  },
  {
    label: 'MLS views digest', expectImportant: false,
    email: { from: 'noreply@mlsalerts.com', subject: 'Your listing performance this week',
      snippet: '88 Birch Ln got 47 views and 3 saves', bodyText: 'Weekly performance: your listing at 88 Birch Ln received 47 views, 3 saves, and 1 share this week. Keep up the momentum! View your dashboard for more stats.' },
  },
  {
    label: 'CRM drip template', expectImportant: false,
    email: { from: 'success@crmflow.io', subject: 'Just checking in!',
      snippet: 'It has been a while since you logged in', bodyText: 'Hi there! It has been a while since you logged in to CRMFlow. Your pipeline misses you! Here are 3 tips to re-engage cold leads this quarter.' },
  },
  {
    label: 'lead-platform teaser with no detail', expectImportant: false,
    email: { from: 'leads@homesearchpro.com', subject: 'You have 3 new leads waiting!',
      snippet: 'Log in to view your new leads', bodyText: 'You have 3 new leads waiting in your dashboard! Upgrade to Pro to see full contact details and respond faster than competing agents.' },
  },
  {
    label: 'subscription receipt', expectImportant: false,
    email: { from: 'billing@docusign.com', subject: 'Your receipt from DocuSign',
      snippet: 'Thank you for your payment', bodyText: 'Thank you for your payment of $25.00 for your monthly DocuSign Personal plan. This is your receipt. No action is required.' },
  },
  {
    label: 'social notification', expectImportant: false,
    email: { from: 'notification@facebookmail.com', subject: 'You have 4 new notifications',
      snippet: 'People are engaging with your page', bodyText: 'Your page Maple Realty has 4 new notifications: 2 likes, 1 comment, and 1 new follower. See what you missed.' },
  },
  {
    label: 'webinar invite', expectImportant: false,
    email: { from: 'events@agentgrowth.com', subject: 'Free webinar: double your GCI in 2027',
      snippet: 'Join our free training', bodyText: 'Join top producers for a free webinar on doubling your GCI next year. Thursday 7pm ET. Seats are limited — register now!' },
  },
  {
    label: 'cold vendor pitch', expectImportant: false,
    email: { from: 'sales@snapshotmedia.co', subject: 'Stunning listing photos, 24h turnaround',
      snippet: 'We help agents like you sell faster', bodyText: 'Hi! We are a local real-estate photography team offering drone + HDR packages with 24-hour turnaround, starting at $149. Book your first shoot 20% off!' },
  },
  {
    label: 'market roundup digest', expectImportant: false,
    email: { from: 'digest@marketwatchre.com', subject: 'Your weekly market roundup',
      snippet: 'Rates ticked down this week', bodyText: 'Weekly roundup: 30-year rates ticked down to 6.4%, inventory rose 2% MoM, and new listings are up in most metros. Full analysis on our site.' },
  },
  {
    label: 'automated payment confirmation', expectImportant: false,
    email: { from: 'no-reply@epay.com', subject: 'Payment processed',
      snippet: 'Your scheduled payment was processed', bodyText: 'Your scheduled payment of $89.00 for MLS dues was processed successfully on 07/01. No action is required. Do not reply to this email.' },
  },
];

async function main(): Promise<void> {
  console.log(`[judge-eval] running ${CASES.length} labeled cases...\n`);
  let tp = 0, fp = 0, fn = 0, tn = 0;
  let fraudHits = 0, fraudTotal = 0, sevOk = 0, sevTotal = 0;
  const failures: string[] = [];

  for (const [i, c] of CASES.entries()) {
    const { verdict, message } = await judgeEmail(toDealEmail(c, i), 'judge-eval-user', {
      userContextBlock: '', timezone: 'America/Chicago',
    });
    const got = verdict.important;
    const ok = got === c.expectImportant;
    if (c.expectImportant && got) tp++;
    else if (!c.expectImportant && got) { fp++; failures.push(`FALSE FLAG  ${c.label} (severity=${verdict.severity})`); }
    else if (c.expectImportant && !got) { fn++; failures.push(`MISSED      ${c.label}`); }
    else tn++;

    if (c.expectFraud !== undefined) {
      fraudTotal++;
      if (verdict.suspectedFraud === c.expectFraud) fraudHits++;
      else failures.push(`FRAUD MISS  ${c.label} (got suspectedFraud=${verdict.suspectedFraud})`);
    }
    if (c.expectImportant && got && c.expectSeverity) {
      sevTotal++;
      if (c.expectSeverity.includes(verdict.severity)) sevOk++;
      else failures.push(`SEVERITY    ${c.label}: got ${verdict.severity}, wanted ${c.expectSeverity.join('/')}`);
    }
    console.log(`${ok ? '✔' : '✘'} ${c.label} → important=${got} severity=${verdict.severity}${verdict.suspectedFraud ? ' FRAUD' : ''}${message ? '' : ' (silent)'}`);
  }

  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  console.log('\n--- results -------------------------------------------');
  console.log(`important:  precision ${(precision * 100).toFixed(0)}%  recall ${(recall * 100).toFixed(0)}%  (tp=${tp} fp=${fp} fn=${fn} tn=${tn})`);
  if (fraudTotal) console.log(`fraud:      ${fraudHits}/${fraudTotal} correct`);
  if (sevTotal) console.log(`severity:   ${sevOk}/${sevTotal} within accepted band`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\nall cases passed ✔');
  }
}

main().catch(err => { console.error('[judge-eval] fatal', err); process.exit(1); });

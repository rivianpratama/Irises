# Supervisor corrections, seventh file — Fable-authored, 2026-09-08

Live, at 07:57 in the person's zone, her self-note read "they're winding down at 1am" and the reply was
"late. get some sleep". The circadian slot was right (early_morning); the Current time line leads with
the UTC instant (`2026-09-08T00:57Z`) and mentions the local clock second, and she read the first
number. The clock is one of the few things she is allowed to cite, so the line now leads with theirs.
One pair, byte-for-byte, inside the template literal in `src/agents/convo/shared.ts` (the `current_time`
section). The line still begins `Right now it's`, which is what the test pins match on.

OLD:
```
Right now it's ${now.toISOString()} (UTC), which is ${localTime} in ${tz}.
```
NEW:
```
Right now it's ${localTime} for them, in ${tz}. That is the clock you read and cite. The same instant in UTC is ${now.toISOString()}, for computing reminders only.
```
The following sentence (`The user's timezone is ${tz}. For a one-time reminder…`) is unchanged.

Re-pins for Opus: promptBudget.test.ts's clock-line test (it finds the line by `Right now it's` and
asserts the UTC-zone hour appears — still true, since `localTime` is rendered in DEFAULT_TZ=UTC there);
internalWeather.test.ts / threading.test.ts replace the whole line by regex (unchanged);
PROMPT_BUDGET.current_time if the 2% band asks; any golden that carries the section.

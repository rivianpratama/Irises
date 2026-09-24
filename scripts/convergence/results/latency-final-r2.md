# Latency bench — final-r2

| kind | text | first | last | settle | convo | reasoning | cached% | provider | reply |
|------|------|-------|------|--------|-------|-----------|---------|----------|-------|
| idle | hey | 12.8s | 14.6s | 1.8s | 11.6s | 190 | 0% | Reka | one word. / busy or just not a small talk person? |
| task | whats 17% of 2400 | 4.7s | 4.7s | 1.8s | 2.9s | 42 | 66% | Reka | 408 |
| share | finally finished the deck for tomorrow,… | 7.2s | 8.9s | 1.8s | 5.7s | 167 | 0% | Baidu | finally, the deck surrender / an afternoon of your life, one sl… |
| idle | lol | 9.2s | 9.2s | 1.8s | 8.0s | 87 | 0% | Reka | the deck's the one thing that won't ghost you tomorrow |
| task | give me a quick 3 step plan to fix my s… | 4.3s | 7.5s | 1.8s | 2.8s | 46 | 79% | Wafer | wake at same time every day, even weekend / morning sun, first … |
| share | had nasi goreng for dinner again | 4.5s | 4.5s | 1.8s | 2.6s | 109 | 77% | Wafer | nasi goreng becoming a whole commitment at this point |
| task | what does idempotent mean, one line | 4.9s | 7.0s | 1.8s | 2.9s | 30 | 79% | Wafer | doing it twice gives same result as once. / like retry without … |
| idle | ok | n/a | n/a | n/a | 0.0s | 0 | n/a | n/a |  |
| task | rewrite this to sound nicer: send me th… | 5.4s | 7.3s | 1.8s | 4.2s | 60 | 0% | Wafer | here are a couple of softer options: 'could you send the file o… |
| share | gym tomorrow at 6am, wish me luck | 4.3s | 6.5s | 1.8s | 2.7s | 54 | 80% | Wafer | goodluck bro / the 6am alarm you mean the snooze button right |

**first-bubble overall** — n=9 p50=4.9s p90=12.8s max=12.8s
**first-bubble idle** — n=2 p50=12.8s p90=12.8s max=12.8s
**first-bubble task** — n=4 p50=4.9s p90=5.4s max=5.4s
**first-bubble share** — n=3 p50=4.5s p90=7.2s max=7.2s

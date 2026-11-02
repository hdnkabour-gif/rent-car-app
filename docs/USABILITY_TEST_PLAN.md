# Usability test with real employees (acceptance criterion 29)

Automated tests (Vitest, Playwright) show that screens work. They do **not** show that agency staff
find the application easy. This short session does. It is required before any screen is marked
**Accepted** (see `docs/UX_GUIDELINES.md` §8).

## When
- At the end of each slice, on the slice's screens.
- Slice 1 screens to test: login, home, Mon entreprise / مقاولتي, Équipe / الفريق, Historique / السجل.

## Who and where
- 3–5 real employees with different comfort levels with phones and computers. Include at least one
  person who prefers Arabic and at least one who has never seen the application.
- Their **own phone**: inside the agency on the Wi-Fi and, once VPN is set up, once from outside.
  Also one session on the office PC.
- **Synthetic data only**: fictitious company (`example.test` accounts, invented customers and
  plates). No real customer documents.

## How (about 20 minutes per person)
1. Give a one-line goal only, for example "Connecte-toi et trouve le nom de l'entreprise".
   Do not explain where to click and do not help unless the person is completely blocked.
2. Ask them to think aloud. The observer writes down hesitations, wrong taps and words they did not understand.
3. Each person does half the tasks in French and half in Arabic.

### Slice 1 tasks
| # | Task (as told to the employee) | Success when |
|---|---|---|
| 1 | Open the app on your phone and log in with the account you were given. | Dashboard shown in < 1 min without help |
| 2 | Switch the application to Arabic, then back to French. | Done in one tap each |
| 3 | Find the agency's ICE number. | Found in Mon entreprise / مقاولتي |
| 4 | *(Manager)* Add a new employee "Test Employé" with a starting password. | Account created, no help |
| 5 | *(Manager)* Deactivate that employee, then reactivate them. | Confirmation understood; done |
| 6 | *(Manager)* Find who changed the company information today. | Found in Historique / السجل |
| 7 | Enter a wrong password once, then log in correctly. | Error message understood |
| 8 | Log out. | Done without searching |

## Record (one line per task per person)
| Person (initials) | Language | Device | Task | Success (Y/N/with help) | Time | Words or steps not understood | Suggested fix |
|---|---|---|---|---|---|---|---|

## Pass criteria for the slice
- Every task succeeds **without help** for at least 4 of 5 people (or all 3 of 3).
- No label or message that more than one person did not understand.
- The Arabic wording is checked by an Arabic-speaking employee; corrections are applied.
- Problems found are fixed, or logged in `FEATURE_TRACKER.md` with a decision, before the screens
  are marked Accepted.

Record the date, participants (initials only), devices and results in `TEST_PLAN.md`.

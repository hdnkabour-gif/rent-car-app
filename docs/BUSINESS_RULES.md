# Business rules confirmed by the owner

Source: owner answers, 2026-11-02. These rules are agreed scope. Where an item is not yet built,
its feature ID and planned slice are given. Open questions are listed at the end.

## Company and fleet
| # | Rule | Applies to |
|---|---|---|
| BR-01 | Fleet size from about 6 to 60 vehicles, growing over time. | Performance, UI lists |
| BR-02 | **Several branches from day one** (two today, more planned). Every vehicle belongs to one branch; staff work in one or more branches; managers see all branches. | F-020 moved from "Later" to slice 2a (D-026) |
| BR-03 | The person using the app must be able to see **all details of the company**: vehicles, their papers, money, customers, history. Each record shows its full story in one place (vehicle card, customer card), always limited by the user's permissions. | All modules, S-02 |

## Rental pricing and time
| # | Rule | Applies to |
|---|---|---|
| BR-04 | Rentals are priced **per day of 24 hours**. | Reservations, contracts (slices 3–4) |
| BR-05 | A late return may be charged an extra day or forgiven: **the manager decides case by case**. The system shows the delay and proposes the extra day; it never charges it silently. | Check-in (slice 4) |
| BR-06 | **Prices vary by season and by customer.** Owner answer 2026-11-04: there is **no fixed seasonal price list**; the manager enters and changes the price by hand. Each vehicle has a current price per day (changed by the manager when the season changes), and the agreed price of a rental can be changed by an authorized user (with reason, audited). | Pricing (slice 3, done) |

## Handover, inspection and cleaning
| # | Rule | Applies to |
|---|---|---|
| BR-07 | At handover the agency records the vehicle, **takes photos** and **writes the fuel level**. | Check-out (slice 4) |
| BR-08 | Washing/cleaning between rentals happens sometimes, not always; it is **part of the inspection** and recorded there (cleaned yes/no). | Inspection (slice 2a) |
| BR-09 | A returned vehicle is not rentable until it is inspected. After maintenance, and after an unblock, it goes back through inspection (owner-reviewed amendment to the state model, D-028). | Vehicle lifecycle (slice 2a) |

## Locations
| # | Rule | Applies to |
|---|---|---|
| BR-10 | Pickup and return can happen **at the agency, at the airport or at a hotel**; pickup and return places can differ. | Reservations, contracts (slice 3) |

## Customers
| # | Rule | Applies to |
|---|---|---|
| BR-11 | Customers include **Moroccans living abroad (MRE) and tourists** (passport), as well as residents (CIN). Identity document type is not limited to the CIN. | Customers (slice 2c) |

## Money
| # | Rule | Applies to |
|---|---|---|
| BR-12 | Deposit (caution) can be **cash, cheque or card**. Each is tracked as its own instrument with its own status; a cheque or a card hold is never counted as cash in the till. | Finance (slices 4–5), D7 |
| BR-13 | Payments are **cash or bank transfer**. | Finance (slices 4–5) |
| BR-14 | **Discounts, price changes, deposit refunds and deposit retentions belong to the manager**, who can **grant any of these rights to a specific employee**. | Permissions (slice 2a: grant mechanism; slices 4–5: the finance rights) |

## Maintenance
| # | Rule | Applies to |
|---|---|---|
| BR-15 | Maintenance is done by an **external garage**. | Maintenance (phase 2, F-012) |
| BR-16 | The agency tracks **oil changes by mileage and every other maintenance item** (by mileage and/or date). | Maintenance (F-012, M-07) |

## Answers received 2026-11-04
| # | Rule | Applies to |
|---|---|---|
| BR-17 | **Each company has its own paper contract and its own general conditions**, which the manager must be able to change. | Contract template, versioned (slice 4, D-039) |
| BR-18 | Minimum driver age **18**; warn when the customer has no licence or a new licence. | Reservations (slice 4: age refused, warnings); thresholds in company settings |
| BR-19 | The paper contract carries a pre-printed number; the paper fields are: renter (name, nationality, birth date, profession, passport/CIN, licence, address in Morocco, other address, phone), other driver, vehicle box (make, plate, dates, extension, km out/in, days, time out, amount, payment method, rest), fuel, vehicle diagram, observations, responsibility clause, washing yes/no, signatures (company stamp, client 1, client 2), handed documents (carte grise, assurance, vignette, visite technique, autorisation, contrat), general conditions on the back. | Printable contract (slice 4) |

The photographed blank contract was used only to model the fields; it is not stored in the repository, and no company identifier (ICE, IF, phones, address) is written in code or fixtures.

## Still open (asked, not yet answered)
1. How will the owner try the first version: on the company test PC, or on a temporary private online demo with fictitious data only (needs explicit approval because of the hosting rule in `CLAUDE.md`)?
2. When, and on which device?
3. ~~Blank paper contract~~ received 2026-11-04. Still useful: any spreadsheet in use (customer names removed).
4. Are invoices with ICE needed for corporate customers? How are contracts numbered today, and does the accountant require gapless numbering?
5. Five to ten real plate examples as staff type them when searching.
6. How long must customer records and ID scans be kept after the last rental, and who may delete them (data-protection policy, law 09-08)? Until answered nothing is deleted; scans are only archived.
7. ~~Minimum driver age~~ answered (18). Still to confirm: how many years makes a licence "new" (default 2, adjustable in settings) and the late-return tolerance (default 60 minutes, adjustable).

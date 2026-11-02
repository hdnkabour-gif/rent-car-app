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
| BR-06 | **Prices vary by season and by customer.** A price list with seasons, plus a price that can be changed for a given rental by an authorized user (with reason, audited). | Pricing (slice 3–4) |

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

## Still open (asked, not yet answered)
1. How will the owner try the first version: on the company test PC, or on a temporary private online demo with fictitious data only (needs explicit approval because of the hosting rule in `CLAUDE.md`)?
2. When, and on which device?
3. A blank copy of the current paper contract and any spreadsheet in use (customer names removed).
4. Are invoices with ICE needed for corporate customers? How are contracts numbered today, and does the accountant require gapless numbering?
5. Five to ten real plate examples as staff type them when searching.

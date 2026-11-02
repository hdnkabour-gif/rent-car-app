# UX guidelines: simple, modern and clear for Moroccan staff

**Status:** Accepted requirement (owner request, 2026-11-02). It applies to every screen in every slice.
**Requirement:** the application must be easy to use, with a modern, elegant interface that a Moroccan
rental-agency employee understands without training. This applies on a phone at the counter or in a car
park, and on the office PC.

> المتطلب: يجب أن يكون التطبيق سهل الاستعمال، بواجهة عصرية وأنيقة وواضحة ومفهومة للموظف المغربي، دون حاجة إلى تكوين طويل، على الهاتف وعلى الحاسوب.

## 1. Who we design for
- Agency employees and managers with varied digital experience. They are comfortable with WhatsApp and
  phone apps but not necessarily with "business software".
- They work bilingually. French is the usual business language, and many people read Arabic more comfortably.
  Both must feel native, not translated.
- They often work on a phone, standing, sometimes outdoors, sometimes with a slow connection.

## 2. Language and wording
1. **Everyday words, not technical ones.** Write "Historique des actions" / "سجل العمليات", not "Audit log".
   Write "Accueil" / "الرئيسية", not "Dashboard". Never show internal codes such as `auth.login`, UUIDs or
   HTTP errors to staff.
2. **Moroccan business vocabulary** where it exists: ICE, IF, RC, Patente, CIN, permis, carte grise,
   assurance, visite technique, caution (deposit), DH.
3. **Arabic is Modern Standard Arabic, written simply.** Use short sentences. Darija is not used in the
   interface. Arabic labels are reviewed by an Arabic-speaking staff member before acceptance.
4. **Every error says what to do next.** For example: "Vérifiez la connexion (Wi-Fi ou VPN)" or
   "L'ICE doit contenir 15 chiffres". Never a bare "Erreur".
5. **Field help sits next to the field** when the format is not obvious (ICE, IF, phone).

## 3. Moroccan formats and defaults
| Item | Rule |
|---|---|
| Currency | Stored as MAD; displayed as `1 250,00 DH` (FR) / `1 250,00 درهم` (AR). Never floating point. |
| Dates | `02/11/2026` or `2 nov. 2026`; time zone Africa/Casablanca; week starts Monday. |
| Digits | Latin digits (0–9) in both languages, as on Moroccan invoices and contracts. |
| Phone | Accept `06…`, `07…`, `05…` and `+212…`; display `06 12 34 56 78`. One tap opens a call or WhatsApp. |
| Identifiers | ICE 15 digits; CIN, licence and registration numbers keep their official formats. Always shown left-to-right, even in Arabic screens. |
| Defaults | Country Morocco, currency MAD, interface French with one-tap Arabic. The choice is remembered per user. |

## 4. Simplicity rules
1. **One screen, one main task.** The primary action is visually obvious (one filled button).
2. **Three taps or fewer** for frequent tasks: find a car, see today's returns, record a payment.
3. **Show only what this person may use.** Navigation and actions follow permissions, and the server
   still enforces them.
4. **Pick, don't type.** Use lists, toggles and date pickers instead of free text when the values are known.
   Examples: country, currency, time zone, vehicle status, fuel level.
5. **Forgiving forms.** Trim spaces and accept common formats. Keep what the user typed after an error.
   Mark the exact field that needs correcting.
6. **Confirm only dangerous actions** (deactivate an account, cancel a reservation). Undo is better than a
   confirmation where possible.

## 5. Visual design
- **Clean and calm.** Light background, white cards, generous spacing, rounded corners and subtle shadows.
  No clutter or decorative noise.
- **Company identity first.** Use the company's trade name and brand colour from company settings in the
  app header. "Fleetora" stays discreet.
- **Typography.** Inter (Latin) and Noto Sans Arabic, self-hosted with no CDN. Body text is at least 16px,
  with good line height for Arabic.
- **Icons always with a text label.** Never show an icon alone for an important action.
- **Colour has meaning and is never the only signal.** Green means done/available, amber means
  attention/expiring, red means problem/blocked, blue is neutral information. Each also gets text or an icon.
- **Accessibility.** WCAG AA contrast, visible keyboard focus, and support for the "reduce motion" setting.

## 6. Phone first
- Touch targets are at least 44×44px. The main navigation sits in a **bottom bar** on phones, within reach of
  the thumb (like WhatsApp). On a PC it is a side menu.
- Tables become **cards** on narrow screens; there is no horizontal scrolling for core data.
- Forms use a single column on phones with the correct keyboard type (number, phone, email).
- Slow or lost connection gives a clear message, a retry button and no lost input.

## 7. Arabic / RTL
- The whole layout mirrors: menus, alignment, arrows, progress.
- Numbers, identifiers, emails, plate numbers and phone numbers stay LTR inside RTL text.
- Test every screen in both languages on a phone width before it is marked Tested.

## 8. Definition of done for any screen
- [ ] French and Arabic labels complete, in plain words, with no internal codes visible.
- [ ] Works at 390px phone width and on desktop; RTL checked.
- [ ] Loading, empty, error and success states designed.
- [ ] Main action obvious; frequent task in three taps or fewer.
- [ ] Moroccan formats applied (DH, dates, phone, identifiers).
- [ ] Reviewed by at least one real employee before the feature is marked **Accepted** (usability check
      with synthetic data).

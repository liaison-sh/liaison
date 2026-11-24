---
title: Recurring invoices
description: "Bill a customer on a fixed cadence, review each month's drafts in one run, and see what is paid by card on Stripe instead."
---

Recurring invoices are for customers you bill on a fixed cadence and who pay by bank transfer or by a payment link. A schedule makes the draft, the **month-end run** asks a person to approve it, and the invoice issues on its day. Customers who pay a subscription by card on Stripe are billed by Stripe: see [Stripe](stripe.md) and [Who issues what](../money/who-issues-what.md).

## See your schedules

Open **Invoicing** and choose **Recurring** in the sidebar, then **Schedules**.

- The first line says when the next drafts come and when they issue, for example "Soonest first. Next: 7 drafts on Fri 27 Nov, to issue on Mon 30 Nov."
- Filter by **All**, **Active** or **Paused**.
- The columns are **Customer**, **Bills**, **Repeats**, **Next invoice**, **Excl. VAT** (with its currency), **Paid by** and **Status**.
- A schedule for a customer who also pays a Stripe subscription shows, in its **Bills** column, what it bills instead.

## Start a schedule

1. Click **New schedule**. The editor opens in a tab.
2. Pick the issuer, the customer and the lines. A line may hold `{period}`, filled in with the period it bills.
3. Choose **Paid by**: bank transfer or **Card link**. With **Card link**, give the link's https address. Liaison does not create the link.
4. Click **Preview next invoice** to see it, then **Start**. **Start** stays off until the schedule has an issuer, a customer and a valid line. **Save** replaces it on an existing schedule.

The side column shows the totals, the next invoices with their draft days, and how the number is taken. No number shows before an invoice issues. **Numbering series** shows, read only, the series of the chosen issuer. **Preview next invoice** fills `{period}` with the period that invoice bills. The editor's title and tab name the customer. After **Pause** or **Save** the editor shows the schedule as it now stands.

A schedule an agent creates with `recurring_schedule_create` is started, or saved as a draft that bills nothing yet. It always issues for review.

## When the customer already pays on Stripe

If the customer has a Stripe subscription, the editor shows a conflict. Choose **Open their subscription**, **Pick another customer**, or **Bill something else**. The last one asks for one line, "What does this schedule bill instead?", so the list can say why two systems bill the same customer. **Start** stays off while the conflict is open.

## Dates

- A schedule bills every month, quarter or year, on the last day of the period, on a day from 1 to 28, or on a given date for a year.
- An invoice issues on its billing day. The draft is made three days before it. A draft day on a Saturday or Sunday moves back to the Friday. The billing day itself never moves.
- A day past the end of the month, such as 30 February, is that month's last day.
- All dates are the issuer's own, in the time zone set on its profile.

## Pause or end a schedule

- **Pause** (or `recurring_schedule_pause`) stops drafting. With `until`, it resumes on that date and the days inside the pause are not billed afterwards. Pausing a paused schedule changes nothing.
- A pause an agent asks for after reading outside text, such as a customer's email, waits for a person.
- `recurring_schedule_update` with `status` set to `ended` stops billing for good. A row of the schedule still waiting in an open month-end run is left out, as a pause leaves it, with the note **Schedule ended**, and the run's card drops it. A row approved before the schedule was paused or ended is left out at issue and takes no number.
- A schedule's drafts and invoices carry its client company, so they show on the company's page and its client portal. The company's page lists the schedules that bill it, and the schedule opens its company with **Open the company**.
- A person a schedule bills cannot be deleted until the schedule ends. Deleting them afterwards clears the person from the ended schedule, which still shows in the list as **Customer** and still opens.

## The month-end run

Each schedule's invoice for a period is made by the month-end run of its issuer and issue day, in four steps. No model is asked anything along the way.

1. **Drafted.** On a schedule's draft day, an hourly job makes one unnumbered draft from the schedule alone. Each draft is one row of the run, with flags such as "First invoice" or "Changed since October". A row that bills five times the last invoice of its schedule or more, or a fifth of it or less, reads "Check the amount" with last time's amount. Running the job twice adds nothing.
2. **Approved.** The run gets one card listing every row, its total and its account manager. Approving it records each row as approved. No number is taken at approval. To change a row, change its draft: the card follows.
3. **Issued.** From 08:00 on the issue day, in the issuer's time zone, the rows issue in order, at most 25 every five minutes. A row that fails stays an unnumbered draft and uses no number. The others keep consecutive numbers and the run ends **partial**.
4. **Checked.** The optional **month-end-check** routine reads what other records say about the run's customers and says it in at most two sentences. It changes nothing and is off until you turn it on.

- **Late.** A run nobody approved, or that did not issue, by the last day of its billing month is late. Nothing of it issues by itself any more: the next morning one new card marked **Late** replaces the card it had and lists its rows as they stand. Approving it issues them then, dated the day they issue; taking a row out drops it, and a late run with every row decided closes. A due date its terms gave is counted from the day the card asks, then from the day it issues; a date a person set stays. An expired Late card is asked again the next morning; a rejected one only when a row changes, and the run's page says so. A row that needs a fix joins the card once fixed. The run's page shows the rows to open, fix or take out, and **Decide in Approvals**. Runs that were already late get their card too, whatever state their rows are in.
- **Who is told.** The Home rows of a run (it waits for approval, it is late, it is held, a row could not issue) go to the people who can decide its card (`invoicing:approve`), and to nobody who only writes documents. The card says the last issue day; the row says only when that day has come.
- **What is approved is what issues.** Each row shows its amounts with the tax it will carry, its due date, its operation type (goods, services or both) and its period, and the approval records its total. A row whose total, customer, tax, terms or lines changed since takes no number and asks again on a new card. A due date its terms gave is counted from the day the invoice issues, and no invoice is due before that day. The run's page and each invoice name who approved last. Approving a run without the card that waits for it withdraws that card.

`recurring_run_unapprove` undoes an approval until the first number is taken, keeping every edit. Only the run's own job issues a row: no person, agent or API call can.

A run opens in its own tab. It shows who approved it, the period and the number range. A partial run lists the rows that could not issue, each with **Fix**, which opens its draft.

## Bill a monthly retainer

A retainer is a schedule with included hours a month and a rate for the hours above them. Set them on the schedule: the project its months are reconciled on, the included hours (`retainer_minutes`), the overage rate (`retainer_overage_rate_minor`, per hour) and whether unused hours roll over to the next month (`retainer_rollover`). Setting them needs the projects money scope of a project lead or finance, not only the invoicing scopes.

- **No month-end run.** The run never drafts a retainer month. Each month is invoiced from the project's planned vs done card once a person reconciles it and presses **Create invoice**: the schedule's fee, then the hours above the included and rolled-in hours at the overage rate. Under the included hours there is no overage line. A retainer can never issue by itself.
- **Waive.** The overage can be waived for one month; the next month is billed as usual.
- **Rollover.** With rollover on, the hours a month did not use are added to the next month only, at most one month's included hours, and never carried further.
- **Hours worked after the month's invoice.** A month can be invoiced before it ends. The hours its invoice did not count, entered late or worked later and whatever day they are dated, are on the project's next card, on a line of their own, and bill on that invoice as that month's: they use what is left of its included hours first (what it rolled on and the next month took is not free again), and the rest bills at that month's overage rate. Hours told two months later or more may bill less than on time, never more. They are billed once; a line set to 0 is not offered again. **Create without the overage** leaves them off too. After a retainer is turned off, ended or replaced, they still bill: beside the new retainer's fee or the project's own lines, or alone from the card of a month with no retainer (**Earlier hours only**).
- **Due date.** A retainer's invoice is due by its schedule's own rule (30 days, on issue, or a number of days), counted from the day it is issued.
- **Prepaid.** With **covers** set to the period ahead, each month's fee is invoiced ahead as an advance, and the month-end invoice deducts it and adds any overage, so it can total zero. The schedule says so when saved: check this way of billing with your accountant. Each advance pays for one month (`advance_draft_create` with `month`, by default the month after the project's last advance), goes to the retainer's customer at the fee's VAT, and only that month's invoice deducts it, for what remains of it after any credit note. The project has one invoice waiting for approval at a time: the next one is raised once the first is issued or discarded.
- **Every month.** A retainer's schedule repeats every month; a quarterly or yearly schedule cannot carry one.
- **One invoice per month.** A month already drafted from one planned vs done card refuses another card's **Create invoice**, naming the draft, and adds nothing to it. Once that month's invoice is credited in full, the month can be invoiced again from its card.
- **Included hours on the project.** Saving a retainer sets this month's and next month's timebox on its project; a daily job adds the next month. A schedule made a retainer during a month keeps that month on the run, and any month the run has already drafted or issued, and is reconciled from the first month after.
- **Changed terms.** The hours, the fee and its lines, the overage rate and the rollover changed during a month apply from the next one. Terms that keep the lines a renewal signed stay named by its agreement. The running month, and any earlier month not invoiced yet, keep the terms they had. A schedule not started yet takes the change at once. A signed retainer renewal (Agreements) does the same from the month it starts, at the earliest the next, and its months' timeboxes carry the new hours. A renewal that starts later keeps its own first month when you change the terms before it.
- **What the list and the editor show.** The terms of the next month (of its first month, when the retainer begins later), the ones a change made now would replace: the editor names that month, the renewal with its first month (**Renewed by AG-2026-017 from December 2026**) and any change to come (**New terms from January 2027**). Correcting a line's text keeps the fee that is in force. A page left open into another month refuses a save that would replace other terms than the ones it shows.
- **Changing terms needs the version.** On a retainer, `recurring_schedule_update` takes a change of the hours, rate, rollover or lines (turning it off too) only with `expected_version`, the version `recurring_list` shows: without it, or once the schedule was changed since, nothing is saved and the answer names the version to read. So a change approved after a renewal was signed never puts the old fee back. The editor sends it for you. Two changes at the same moment: one is saved, the other is refused.
- **A month-end row's change from now on** never replaces lines a signed agreement set: the row says **Lines from now on kept**, with the agreement, and the rest of the change is saved.
- **Turning it off** applies from the next month. The running month is the last retainer month: it and any earlier month not invoiced yet stay on the project's card, with their own hours, fee and overage. The month-end run starts with the first month after, at that month's lines, never on a past day. A month to come whose retainer invoice or advance is already made (drafted or issued) is a retainer month too, so the run starts after it and bills nothing twice. The answer and the editor name the last retainer month and the run's first one, and any renewal signed for a later month, which no longer applies. An advance of another retainer on the same project holds none of this schedule's months. The lines can be changed afterwards; a quarterly or yearly period that would hold a retainer month is refused.
- **Turning it on again** applies from the next month too, on the same project. In the month it was turned off, no month goes to the run, unless the run has already drafted or issued the next one (a billing day early in the month is drafted the month before): that month is billed by the run, with no hours above it, the retainer starts with the month after, its advance is refused, and the answer and the editor name the month. A renewal signed for a month after the new start applies again from its own month. One signed for the start month or earlier stays signed when the lines saved are its lines; otherwise it no longer applies, and the answer and the editor say so. Once it was turned off with months on a project, the schedule is a retainer on that project only: a schedule for another project is a new schedule.
- **Ending it** leaves the running month and any earlier month not invoiced yet on the project's card, whether the retainer is on or was turned off before. A month to come whose advance or retainer invoice is already made stays too. No later month is billed. The answer and the editor name the last retainer month.

## Not built yet

- Asking the client to confirm a schedule first.

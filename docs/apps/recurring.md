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
- `recurring_schedule_update` with `status` set to `ended` stops billing for good.
- A person a schedule bills cannot be deleted until the schedule ends. Deleting them afterwards clears the person from the ended schedule, which still shows in the list as **Customer** and still opens.

## The month-end run

Each schedule's invoice for a period is made by the month-end run of its issuer and issue day, in four steps. No model is asked anything along the way.

1. **Drafted.** On a schedule's draft day, an hourly job makes one unnumbered draft from the schedule alone. Each draft is one row of the run, with flags such as "First invoice" or "Changed since October". A row that bills five times the last invoice of its schedule or more, or a fifth of it or less, reads "Check the amount" with last time's amount. Running the job twice adds nothing.
2. **Approved.** The run gets one card listing every row, its total and its account manager. Approving it records each row as approved. No number is taken at approval. To change a row, change its draft: the card follows.
3. **Issued.** From 08:00 on the issue day, in the issuer's time zone, the rows issue in order, at most 25 every five minutes. A row that fails stays an unnumbered draft and uses no number. The others keep consecutive numbers and the run ends **partial**.
4. **Checked.** The optional **month-end-check** routine reads what other records say about the run's customers and says it in at most two sentences. It changes nothing and is off until you turn it on.

`recurring_run_unapprove` undoes an approval until the first number is taken, keeping every edit. Only the run's own job issues a row: no person, agent or API call can.

A run opens in its own tab. It shows who approved it, the period and the number range. A partial run lists the rows that could not issue, each with **Fix**, which opens its draft.

## Bill a monthly retainer

A retainer is a schedule with included hours a month and a rate for the hours above them. Set them on the schedule: the project its months are reconciled on, the included hours (`retainer_minutes`), the overage rate (`retainer_overage_rate_minor`, per hour) and whether unused hours roll over to the next month (`retainer_rollover`). Setting them needs the projects money scope of a project lead or finance, not only the invoicing scopes.

- **No month-end run.** The run never drafts a retainer month. Each month is invoiced from the project's planned vs done card once a person reconciles it and presses **Create invoice**: the schedule's fee, then the hours above the included and rolled-in hours at the overage rate. Under the included hours there is no overage line. A retainer can never issue by itself.
- **Waive.** The overage can be waived for one month; the next month is billed as usual.
- **Rollover.** With rollover on, the hours a month did not use are added to the next month only, at most one month's included hours, and never carried further.
- **Prepaid.** With **covers** set to the period ahead, each month's fee is invoiced ahead as an advance, and the month-end invoice deducts it and adds any overage, so it can total zero. The schedule says so when saved: check this way of billing with your accountant.
- **Included hours on the project.** Saving a retainer sets this month's and next month's timebox on its project; a daily job adds the next month. Terms changed during a month apply from the next one. A schedule made a retainer during a month keeps that month on the run and is reconciled from the next.

## Not built yet

- Asking the client to confirm a schedule first.

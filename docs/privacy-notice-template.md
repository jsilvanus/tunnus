# Privacy notice template

Use this template when a deployment does not use the built-in page at
`<issuer>/privacy` (for example, when it sets `PRIVACY_NOTICE_URL` and hosts the
notice on its own website). It has the same sections as the built-in page. Replace
every `<...>` placeholder, and keep the retention figures in step with the
deployment's settings.

Adapt the text to your own legal review. This template is not legal advice.

---

# Privacy notice: sign-in service

**Brand:** `<Service name>`
**Last updated:** `<date>`

## Data controller

`<Controller name>`
Contact: `<Controller contact, for example privacy@example.org>`

## Data protection officer

Only if you have one:

`<DPO name or role>`, `<DPO contact>`

## What we store

- Your email address.
- Your display name.
- The groups you belong to.
- The times you signed in.
- Log entries (audit records) about your account. These can include your IP
  address for a limited time (see below).

We do not store passwords. Sign-in uses a one-time code sent to your email
address.

## Why we store it

So that you can sign in to services that use `<Service name>`, and so that
sign-in stays secure. The services you sign in to receive a stable identifier for your account, your
email address, your display name and your group membership. They do not receive
the other data listed above.

## How long we keep it

| Data                              | Kept for                                                                    | Notes                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Account with no sign-in           | 365 days after the last sign-in (or after creation, if you never signed in) | You get an email 30 days before deletion. Signing in at any time keeps the account.            |
| Administrator accounts            | Not deleted automatically                                                   | Handled by hand                                                                                |
| Audit log entries                 | 365 days                                                                    |                                                                                                |
| IP addresses in audit log entries | 30 days                                                                     | Removed from the entry; the rest of the entry is kept until the audit log entry itself expires |
| Sign-in codes                     | About one day after they expire                                             |                                                                                                |

If the deployment changes these settings, change this table too. A setting of
zero means that deletion or removal does not happen for that data, so say that
here instead of the number.

## Processors

We use these service providers to process your data on our behalf.

| Processor            | Purpose                                   | Location              |
| -------------------- | ----------------------------------------- | --------------------- |
| `<Mail provider>`    | Sending sign-in codes and account notices | `<Country or region>` |
| `<Hosting provider>` | Running the service and its database      | `<Country or region>` |

## Your rights

You can ask the data controller for access to your data, correction or deletion
of it, and restriction of its processing. You can also complain to a data
protection supervisory authority. To use these rights, or to ask a question about
this notice, contact `<Controller contact>`.

## Changes to this notice

We update this notice when our processing changes. The date at the top shows when
it was last changed.

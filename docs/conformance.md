# OpenID conformance testing

This document describes how to run the OpenID Foundation conformance suite
against a running Tunnus instance, using the Basic OP profile. This is a manual step: it needs a deployed test instance and a person
to run the suite and read its results. It is not part of the automated tests in
this repository.

## What you need

- A test instance of Tunnus reachable over HTTPS from the machine that runs the
  suite. Use a test database, not production data. The suite creates users and
  signs in as them.
- The suite itself. Either use the hosted instance at
  <https://www.certification.openid.net>, or run the suite yourself from its
  source repository, which is linked from that site.
- A registered client for the suite, added to `CLIENTS_FILE`.
- Mail that you can read. Sign-in codes are sent by mail. A test instance can use
  `MAIL_PROVIDER=console` and read the codes from the log, provided the log is
  reachable.

## Test instance settings

Use the same settings as the deployment guide ([`deployment.md`](deployment.md)),
with these differences for the test instance:

- `ISSUER` is the public HTTPS URL of the test instance, including any path
  prefix.
- `SIGNUP_EMAIL_ALLOW` allows the address the suite uses to sign up. The suite
  needs an address that can receive mail, or one that the console provider logs.

Start the instance with a fresh database, run migrations and create one admin with
`tunnus-admin bootstrap` so you can manage the test client.

## Registering the client

Add a client to `CLIENTS_FILE`. A starting point is in
[`clients.example.json`](../clients.example.json). The client needs:

- `client_id` and `client_secret`. Put the secret in the environment and refer to
  it as `${NAME}` so it does not sit in the file.
- The redirect URI that the suite gives you for the run. Redirect URIs must match
  exactly.
- `token_endpoint_auth_method` that matches the test plan's configuration (for
  example `client_secret_basic` or `client_secret_post`).
- `first_party: true` if you want the consent screen skipped for the run.

Restart Tunnus after changing `CLIENTS_FILE`.

## Running the Basic OP test plan

1. In the suite, create a test plan for the OpenID Connect Basic OP profile. In
   the suite's catalogue this is the basic certification test plan
   (`oidcc-basic-certification-test-plan`).
2. Enter the instance's issuer URL (`ISSUER`) and the client details from
   `CLIENTS_FILE`.
3. Start the plan. When the suite asks for a sign-in, complete it in a browser
   with the test account. For each one-time code, read the code from the mail or
   the log.
4. Let the plan run to the end and read the result of each module.

Exact menu names and screens change between suite versions, so follow the suite's
own documentation for those steps.

## Expected results

- A module that passes is good.
- A module that fails is a bug or a configuration problem. Fix it, redeploy and
  run again.
- A module that is skipped or reports "not applicable" is expected only when the
  test covers a feature Tunnus does not offer. Check the reason the suite gives
  for each skip. Do not accept a skip you cannot explain.
- Warnings need a look. Record each one with its reason.

Keep the plan's result export and the instance version (`/health` shows it) with
the release notes, so the claim can be traced to a build.

## Repeating the run

Run the plan again after changes to the provider, the signing keys, or the
settings that affect tokens (for example `KEY_RETIRED_GRACE_DAYS` or the cookie
settings).

# Security Policy

TideGate is an execution kernel: its whole point is enforcing boundaries
around untrusted, AI-written code. Security reports are taken seriously.

## Reporting a vulnerability

Please **do not** open a public issue for suspected vulnerabilities.

- Email: [emanuele.puccetti@icloud.com](mailto:emanuele.puccetti@icloud.com)
- Or use GitHub private vulnerability reporting on this repository
  ("Report a vulnerability" under the Security tab).

Include what you can: affected package and version, a reproduction or proof
of concept, and the impact you believe it has (e.g. sandbox escape, policy
bypass, permission escalation, budget bypass, audit evasion).

You will get an acknowledgement within 72 hours and a status update at least
weekly until resolution. Please give us reasonable time to ship a fix before
any public disclosure.

## Scope

- The four packages in this repository (`contracts`, `sdk`, `runtime`,
  `auth-server`).
- The hosted TideGate platform is out of scope here — report platform issues
  to the same email.

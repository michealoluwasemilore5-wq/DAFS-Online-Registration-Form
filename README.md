# DAFS Student Registration

Render-ready Node/Express + PostgreSQL student registration site.

## Files
All frontend files and the backend are at the repository root.

## Render
- Build command: `npm install`
- Start command: `node server.js`
- Root directory: leave blank

## Required environment variables
- `DATABASE_URL`
- `NODE_ENV=production`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `SESSION_SECRET`

The backend uses PostgreSQL for registrations and PostgreSQL-backed sessions for reliable admin login persistence.


## Paystack payment-first registration

The registration form now requires a successful Paystack payment of **₦1,000** before the application is inserted into the `registrations` table.

### Payment flow
1. Applicant completes the form.
2. The site sends the form to `/api/paystack/initialize`.
3. The server stores it in `pending_registrations` and initializes a Paystack ₦1,000 transaction.
4. Applicant pays on Paystack.
5. Paystack returns the applicant to `payment-callback.html`.
6. The server verifies the transaction directly with Paystack.
7. Only after verification does the server move the application into `registrations`.
8. The admin dashboard can then see the paid registration and payment reference.

### Required Render environment variables

Set these in Render (or your server environment):

`DATABASE_URL=...`
`PAYSTACK_SECRET_KEY=...`
`ADMIN_USERNAME=...`
`ADMIN_PASSWORD=...`
`SESSION_SECRET=...`

Recommended:

`PUBLIC_BASE_URL=https://your-live-site.onrender.com`

The **Paystack Secret Key must never be placed in HTML, browser JavaScript, GitHub, or this ZIP**. The Public Key is intentionally used by Paystack's client-side integration where needed, but this implementation initializes and verifies the payment on the server.

### Paystack mode

This ZIP includes the Paystack **LIVE Public Key** in `app.js`:

`pk_live_086c7eceb4af642ec2e39d3cf6ef5db07ef4b2be`

The current payment flow uses Paystack's hosted checkout and initializes/verifies transactions on the server, so the key that actually controls live transaction authorization is the matching `PAYSTACK_SECRET_KEY` set in Render. **Do not put the secret key in this ZIP or in browser code.**

### Important

Paystack will settle successful payments to the settlement bank account configured in the Paystack merchant account. The old First Bank account instructions are not used by this payment integration.

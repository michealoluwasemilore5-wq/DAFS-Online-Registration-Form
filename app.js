// Paystack Live Public Key (safe for browser-side use)
const PAYSTACK_PUBLIC_KEY = 'pk_live_086c7eceb4af642ec2e39d3cf6ef5db07ef4b2be';

const form = document.getElementById('registrationForm');
const message = document.getElementById('formMessage');
const button = document.getElementById('submitBtn');

function showMessage(text, type) {
  message.textContent = text;
  message.className = `message show ${type}`;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!form.checkValidity()) {
    form.reportValidity();
    showMessage('Please complete all required fields.', 'error');
    return;
  }

  button.disabled = true;
  button.querySelector('span').textContent = 'Preparing payment...';
  message.className = 'message';

  const data = Object.fromEntries(new FormData(form).entries());

  try {
    // The registration is NOT submitted here. The server stores it as
    // pending and creates a Paystack checkout. It becomes a registration
    // only after Paystack payment is verified server-side.
    const response = await fetch('/api/paystack/initialize', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(data)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Could not start payment.');
    }

    // Paystack's hosted checkout.
    window.location.href = result.authorizationUrl;
  } catch (err) {
    showMessage(err.message || 'Could not start payment. Please try again.', 'error');
    button.disabled = false;
    button.querySelector('span').textContent = 'Submit Registration';
  }
});

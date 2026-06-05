// supabase-fix.js — Connection & config fix only
const SB_URL = 'https://dkdnlgfwlrwdxtrovrr.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrZG5sZ3dmbHJ3ZHh0cm92cnJxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MjM4NjUsImV4cCI6MjA5NTk5OTg2NX0.vf3uAq8uInMBMEw6fU-qng2kg_BjunGNgFhGoA_V4Gk';

// Fixed client — stops "Failed to fetch"
window.supabaseClient = supabase.createClient(SB_URL, SB_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  },
  global: {
    fetch: (...args) => fetch(...args)
  }
});

// Stripe config
window.STRIPE_PKEY = 'pk_live_51TZl6YICF2fQjVNyfM7zLkgw24kRiDtf39YPpbvsLsDn8YM6RJ1VncJedSUgJPIoPfjra1T3vCgPTQbivFSDf17p00bGe517yQ';
window.STRIPE_SECRET = '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';
window.STRIPE_PRICE_ID = 'price_1TZoJYEuJ32ClDs6SUb7yfVC';
window.FIXED_SETUP_FEE = 0;
window.STRIPE_SUCCESS_URL = 'https://build-tracker.co.uk?success=1';
window.STRIPE_CANCEL_URL = 'https://build-tracker.co.uk?canceled=1';

window.stripeClient = Stripe(window.STRIPE_PKEY);
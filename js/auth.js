let isSignUp = false;

function toggleAuth() {
  isSignUp = !isSignUp;
  document.getElementById('authTitle').textContent = isSignUp ? 'Create Account' : 'Sign In';
  document.getElementById('authBtn').textContent = isSignUp ? 'Sign Up' : 'Sign In';
  document.getElementById('nameField').style.display = isSignUp ? 'block' : 'none';
  document.querySelector('.toggle-text').textContent = isSignUp 
    ? "Already have an account? Sign In" 
    : "Don't have an account? Sign Up";
}

async function doSignIn() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value.trim();
  const full_name = document.getElementById('full_name')?.value.trim() || '';

  if (isSignUp) {
    // SIGN UP + SET 14 DAY TRIAL
    const trialEndDate = new Date(Date.now() + 14 * 86400000).toISOString();

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: full_name,
          is_trial: true,
          trial_ends: trialEndDate
        }
      }
    });

    if (error) return alert('❌ ' + error.message);
    alert('✅ Account created! Check your email to confirm.');

  } else {
    // SIGN IN + CHECK TRIAL STATUS
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return alert('❌ ' + error.message);

    const userData = data.user.user_metadata;
    const now = new Date();
    const endDate = new Date(userData.trial_ends);

    // IF TRIAL EXPIRED → REDIRECT TO STRIPE
    if (userData.is_trial === true && now > endDate) {
      alert('⚠️ Your trial has ended! Subscribe now to continue.');
      window.location.href = "https://buy.stripe.com/cNi9AUaGGd2ed960yrbsc00";
      return;
    }

    // ALL GOOD → SHOW DASHBOARD
    showDashboard(data.user);
  }
}

function showDashboard(user) {
  document.getElementById('authSection').style.display = 'none';
  document.getElementById('dashboardSection').style.display = 'block';
  document.getElementById('userName').textContent = user.user_metadata?.full_name || user.email;
}

async function signOut() {
  await supabase.auth.signOut();
  document.getElementById('authSection').style.display = 'block';
  document.getElementById('dashboardSection').style.display = 'none';
}

// AUTO LOGIN IF SESSION EXISTS
supabase.auth.onAuthStateChange((event, session) => {
  if (session?.user) showDashboard(session.user);
});
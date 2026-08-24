<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowLeft, ArrowRight, Check, LockKeyhole, Mail, ShieldCheck, Sparkles } from "@lucide/svelte";
  import { getSupabaseClient } from "./supabase";

  let email = "";
  let isCheckingSession = true;
  let isSending = false;
  let sent = false;
  let error = "";

  const client = getSupabaseClient();

  onMount(() => {
    void checkSession();
  });

  async function checkSession() {
    if (!client) {
      error = "Admin sign-in is not configured on this device.";
      isCheckingSession = false;
      return;
    }

    const { data } = await client.auth.getSession();
    if (data.session) {
      window.location.replace("/admin/reports");
      return;
    }
    isCheckingSession = false;
  }

  async function sendSignInLink(event: SubmitEvent) {
    event.preventDefault();
    if (!client || !email.trim() || isSending) return;

    isSending = true;
    error = "";
    const { error: signInError } = await client.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${window.location.origin}/admin/reports`,
      },
    });
    isSending = false;

    if (signInError) {
      error = signInError.message;
      return;
    }
    sent = true;
  }
</script>

<svelte:head>
  <title>Admin sign in | Common Days</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<main class="admin-page admin-login-page">
  <header class="admin-site-header">
    <a class="admin-brand" href="/" aria-label="Common Days home">
      <span class="admin-brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
      <span>COMMON DAYS</span>
    </a>
    <span class="admin-private-pill"><LockKeyhole size={14} /> PRIVATE ADMIN</span>
  </header>

  <div class="admin-login-grid">
    <section class="admin-login-intro" aria-labelledby="admin-login-title">
      <span class="admin-eyebrow">CALENDAR QUALITY CONTROL</span>
      <h1 id="admin-login-title">One person checks.<br /><em>Everyone gets the fix.</em></h1>
      <p>Reports from students land in one private queue. Review each claim before anything is changed in the shared calendar library.</p>

      <div class="admin-process-strip" aria-label="Admin review process">
        <span><b>01</b> Student reports a date</span>
        <ArrowRight size={18} aria-hidden="true" />
        <span><b>02</b> You verify the claim</span>
        <ArrowRight size={18} aria-hidden="true" />
        <span><b>03</b> The decision is recorded</span>
      </div>
    </section>

    <section class="admin-auth-card" aria-labelledby="sign-in-heading">
      <div class="admin-auth-icon"><ShieldCheck size={28} /></div>
      <span class="admin-eyebrow dark">SOLE ADMIN ACCESS</span>
      <h2 id="sign-in-heading">Open your review desk</h2>

      {#if sent}
        <div class="admin-sent-state" role="status">
          <span><Check size={21} /></span>
          <strong>Check your email</strong>
          <p>If this email belongs to the Common Days admin, a secure sign-in link is on its way.</p>
          <button type="button" class="admin-text-button" onclick={() => { sent = false; error = ""; }}>Use a different email</button>
        </div>
      {:else}
        <p class="admin-auth-copy">Enter the email attached to the admin account. We will send a one-time sign-in link, so there is no password to remember.</p>
        <form onsubmit={sendSignInLink}>
          <label for="admin-email">Admin email</label>
          <div class="admin-email-field">
            <Mail size={18} aria-hidden="true" />
            <input id="admin-email" type="email" autocomplete="email" required bind:value={email} placeholder="you@example.com" />
          </div>
          <button class="admin-primary-button" type="submit" disabled={isCheckingSession || isSending || !email.trim()}>
            {#if isCheckingSession}
              Checking your session...
            {:else if isSending}
              Sending secure link...
            {:else}
              Email me a sign-in link <ArrowRight size={17} />
            {/if}
          </button>
        </form>
      {/if}

      {#if error}<div class="admin-inline-error" role="alert">{error}</div>{/if}

      <div class="admin-auth-footnote"><Sparkles size={15} /> Only the configured admin can open the review queue.</div>
      <a class="admin-back-link" href="/"><ArrowLeft size={15} /> Back to the public calendar</a>
    </section>
  </div>
</main>

<script lang="ts">
  import { onMount } from "svelte";
  import { format, parseISO } from "date-fns";
  import {
    AlertTriangle,
    ArrowLeft,
    Check,
    ChevronRight,
    Clock3,
    Inbox,
    LoaderCircle,
    LockKeyhole,
    LogOut,
    RefreshCw,
    School,
    ShieldCheck,
    X,
  } from "@lucide/svelte";
  import type {
    AdminMeResponse,
    AdminReport,
    AdminReportAction,
    AdminReportResponse,
    AdminReportsResponse,
    AdminReportStatus,
  } from "@commondays/shared";
  import { adminFetch, getSupabaseClient } from "./supabase";

  const tabs: { id: AdminReportStatus; label: string }[] = [
    { id: "submitted", label: "New" },
    { id: "reviewing", label: "Reviewing" },
    { id: "resolved", label: "Resolved" },
    { id: "rejected", label: "Rejected" },
  ];

  const reasonLabels: Record<AdminReport["reason"], string> = {
    wrong_date: "Wrong date",
    missing_date: "Missing date",
    wrong_name: "Wrong name",
    other: "Other issue",
  };

  let activeStatus: AdminReportStatus = "submitted";
  let reports: AdminReport[] = [];
  let selectedReport: AdminReport | null = null;
  let adminEmail = "";
  let resolutionNotes = "";
  let isInitializing = true;
  let isLoadingReports = false;
  let isLoadingDetail = false;
  let mutation: AdminReportAction["action"] | "" = "";
  let loadError = "";
  let accessDenied = false;
  let notice = "";
  let requestNumber = 0;
  let detailRequestNumber = 0;

  const client = getSupabaseClient();

  onMount(() => {
    const subscription = client?.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" && !session) window.location.replace("/admin/login");
    }).data.subscription;
    void initialize();
    return () => subscription?.unsubscribe();
  });

  async function initialize() {
    if (!client) {
      loadError = "Admin authentication is not configured. Add the two VITE_SUPABASE environment variables and restart the app.";
      isInitializing = false;
      return;
    }

    const { data, error } = await client.auth.getSession();
    if (error || !data.session) {
      window.location.replace("/admin/login");
      return;
    }

    try {
      const me = await request<AdminMeResponse>("/api/v1/admin/me");
      adminEmail = me.admin.email ?? "Configured admin";
      await loadReports(activeStatus);
    } catch (cause) {
      handleError(cause);
    } finally {
      isInitializing = false;
    }
  }

  async function request<T>(path: string, init?: RequestInit) {
    let response: Response;
    try {
      response = await adminFetch(path, init);
    } catch (cause) {
      if (cause instanceof Error && cause.message === "ADMIN_SESSION_REQUIRED") {
        await client?.auth.signOut({ scope: "local" });
        window.location.replace("/admin/login");
      }
      throw cause;
    }
    if (response.status === 401) {
      await client?.auth.signOut({ scope: "local" });
      window.location.replace("/admin/login");
      throw new Error("ADMIN_SESSION_REQUIRED");
    }
    if (response.status === 403) {
      accessDenied = true;
      throw new Error("This signed-in account is not the configured Common Days admin.");
    }
    if (!response.ok) {
      let message = "The admin service could not complete that request.";
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // Keep the safe fallback when an upstream response is not JSON.
      }
      throw new Error(message);
    }
    return (await response.json()) as T;
  }

  function handleError(cause: unknown) {
    if (cause instanceof Error && cause.message === "ADMIN_SESSION_REQUIRED") return;
    if (!accessDenied) loadError = cause instanceof Error ? cause.message : "The review queue is unavailable.";
  }

  async function loadReports(status: AdminReportStatus, preferredId?: string) {
    const currentRequest = ++requestNumber;
    isLoadingReports = true;
    loadError = "";
    try {
      const body = await request<AdminReportsResponse>(`/api/v1/admin/reports?status=${status}`);
      if (currentRequest !== requestNumber) return;
      reports = body.reports;
      const next = reports.find((report) => report.id === preferredId) ?? reports[0] ?? null;
      selectedReport = next;
      resolutionNotes = next?.resolutionNotes ?? "";
      if (next) await loadReportDetail(next.id, currentRequest);
    } catch (cause) {
      handleError(cause);
    } finally {
      if (currentRequest === requestNumber) isLoadingReports = false;
    }
  }

  async function loadReportDetail(id: string, parentRequest = requestNumber) {
    const detailRequest = ++detailRequestNumber;
    isLoadingDetail = true;
    try {
      const body = await request<AdminReportResponse>(`/api/v1/admin/reports/${id}`);
      if (parentRequest !== requestNumber || detailRequest !== detailRequestNumber) return;
      selectedReport = body.report;
      resolutionNotes = body.report.resolutionNotes ?? "";
    } catch (cause) {
      handleError(cause);
    } finally {
      if (parentRequest === requestNumber && detailRequest === detailRequestNumber) isLoadingDetail = false;
    }
  }

  async function selectStatus(status: AdminReportStatus) {
    if (status === activeStatus && !loadError) return;
    activeStatus = status;
    notice = "";
    await loadReports(status);
  }

  async function selectReport(report: AdminReport) {
    selectedReport = report;
    resolutionNotes = report.resolutionNotes ?? "";
    notice = "";
    await loadReportDetail(report.id);
  }

  async function runAction(action: "start_review" | "reject") {
    if (!selectedReport || mutation) return;
    const actionBody: AdminReportAction = action === "start_review"
      ? { action }
      : { action, resolutionNotes: resolutionNotes.trim() };
    if (action === "reject" && resolutionNotes.trim().length < 3) return;

    mutation = action;
    loadError = "";
    try {
      const body = await request<AdminReportResponse>(`/api/v1/admin/reports/${selectedReport.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(actionBody),
      });
      notice = body.message ?? (action === "start_review" ? "Review started." : "Report rejected.");
      activeStatus = body.report.status;
      await loadReports(activeStatus, body.report.id);
    } catch (cause) {
      handleError(cause);
    } finally {
      mutation = "";
    }
  }

  async function signOut() {
    await client?.auth.signOut({ scope: "local" });
    window.location.replace("/admin/login");
  }

  function displayDate(value: string) {
    try {
      return format(parseISO(value), "MMM d, yyyy");
    } catch {
      return value;
    }
  }

  function eventDate(report: AdminReport) {
    if (!report.eventStartDate) return "No event selected";
    if (!report.eventEndDate || report.eventEndDate === report.eventStartDate) return displayDate(report.eventStartDate);
    return `${displayDate(report.eventStartDate)} to ${displayDate(report.eventEndDate)}`;
  }
</script>

<svelte:head>
  <title>Report review | Common Days</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<main class="admin-page admin-dashboard-page">
  <header class="admin-dashboard-header">
    <a class="admin-brand" href="/" aria-label="Common Days home">
      <span class="admin-brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
      <span>COMMON DAYS <b>/ ADMIN</b></span>
    </a>
    <div class="admin-account">
      <span><i></i>{adminEmail || "Checking admin access..."}</span>
      <button type="button" onclick={signOut}><LogOut size={15} /> Sign out</button>
    </div>
  </header>

  {#if accessDenied}
    <section class="admin-blocked-card">
      <span><LockKeyhole size={28} /></span>
      <div><p class="admin-eyebrow dark">ACCESS DENIED</p><h1>This account is not the admin.</h1><p>Only the single account configured for Common Days can review calendar reports.</p></div>
      <button class="admin-secondary-button" type="button" onclick={signOut}>Sign in with the admin account</button>
    </section>
  {:else}
    <section class="admin-dashboard-title">
      <div>
        <span class="admin-eyebrow">CALENDAR QUALITY CONTROL</span>
        <h1>Report review desk</h1>
      </div>
      <p>Verify student reports and record a decision. Shared calendar dates are never changed automatically.</p>
    </section>

    <section class="admin-workspace" aria-label="Calendar report review application">
      <div class="admin-window-bar">
        <span class="admin-window-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <strong><ShieldCheck size={15} /> PRIVATE REVIEW QUEUE</strong>
        <span>{reports.length} {reports.length === 1 ? "REPORT" : "REPORTS"}</span>
      </div>

      <nav class="admin-status-tabs" aria-label="Report status">
        {#each tabs as tab}
          <button class:active={activeStatus === tab.id} type="button" aria-pressed={activeStatus === tab.id} onclick={() => selectStatus(tab.id)}>
            <span class={`admin-status-dot ${tab.id}`}></span>{tab.label}
          </button>
        {/each}
        <button class="admin-refresh" type="button" aria-label="Refresh reports" onclick={() => loadReports(activeStatus)} disabled={isLoadingReports}>
          <RefreshCw class={isLoadingReports ? "spinning" : undefined} size={16} />
        </button>
      </nav>

      {#if notice}<div class="admin-notice" role="status"><Check size={16} /> {notice}</div>{/if}
      {#if loadError}<div class="admin-load-error" role="alert"><AlertTriangle size={17} /> <span>{loadError}</span><button type="button" onclick={() => loadReports(activeStatus)}>Try again</button></div>{/if}

      <div class="admin-review-grid">
        <aside class="admin-report-list" aria-label="Reports">
          {#if isInitializing || isLoadingReports}
            <div class="admin-list-state"><LoaderCircle class="spinning" size={23} /> Loading reports...</div>
          {:else if reports.length === 0}
            <div class="admin-list-state empty"><Inbox size={29} /><strong>No {tabs.find((tab) => tab.id === activeStatus)?.label.toLowerCase()} reports</strong><span>This queue is clear.</span></div>
          {:else}
            {#each reports as report (report.id)}
              <button class:selected={selectedReport?.id === report.id} type="button" aria-pressed={selectedReport?.id === report.id} onclick={() => selectReport(report)}>
                <span class={`admin-status-dot ${report.status}`}></span>
                <span class="admin-report-summary">
                  <span><strong>{report.schoolShortName}</strong><b>{report.academicYear}</b></span>
                  <em>{reasonLabels[report.reason]}</em>
                  <small>{report.details}</small>
                  <time datetime={report.createdAt}>{displayDate(report.createdAt)}</time>
                </span>
                <ChevronRight size={17} aria-hidden="true" />
              </button>
            {/each}
          {/if}
        </aside>

        <section class="admin-report-detail" aria-live="polite">
          {#if isInitializing}
            <div class="admin-detail-state"><LoaderCircle class="spinning" size={27} /> Opening your review desk...</div>
          {:else if !selectedReport}
            <div class="admin-detail-state"><Inbox size={32} /><strong>Select a report to inspect it</strong></div>
          {:else}
            <header>
              <div>
                <span class={`admin-detail-status ${selectedReport.status}`}>{selectedReport.status.replace("_", " ")}</span>
                <h2>{selectedReport.schoolShortName} calendar report</h2>
                <p>{selectedReport.schoolName} · {selectedReport.academicYear}</p>
              </div>
              {#if isLoadingDetail}<LoaderCircle class="spinning" size={20} aria-label="Loading report details" />{/if}
            </header>

            <div class="admin-detail-block coral">
              <span>STUDENT REPORT</span>
              <strong>{reasonLabels[selectedReport.reason]}</strong>
              <p>{selectedReport.details}</p>
            </div>

            <div class="admin-context-grid">
              <div class="admin-detail-block">
                <span><School size={14} /> CURRENT CALENDAR ENTRY</span>
                <strong>{selectedReport.eventName ?? "No specific event selected"}</strong>
                <p>{eventDate(selectedReport)}</p>
              </div>
              <div class="admin-detail-block unavailable">
                <span><AlertTriangle size={14} /> SOURCE FILE</span>
                <strong>No source file available</strong>
                <p>Secure source-file preview is not connected in this slice.</p>
              </div>
            </div>

            <div class="admin-report-meta">
              <span><Clock3 size={14} /> Submitted {displayDate(selectedReport.createdAt)}</span>
              <span>Report ID {selectedReport.id.slice(0, 8)}</span>
            </div>

            {#if selectedReport.status === "submitted"}
              <div class="admin-action-panel lime">
                <div><span>NEXT STEP</span><strong>Verify this claim against the official calendar.</strong><p>Starting review moves this report into your private working queue.</p></div>
                <button class="admin-primary-button compact" type="button" disabled={Boolean(mutation)} onclick={() => runAction("start_review")}>
                  {#if mutation === "start_review"}<LoaderCircle class="spinning" size={17} /> Starting...{:else}<ShieldCheck size={17} /> Start review{/if}
                </button>
              </div>
            {:else if selectedReport.status === "reviewing"}
              <div class="admin-action-panel">
                <div><span>REVIEW DECISION</span><strong>Reject an incorrect report</strong><p>Explain what you verified. Calendar correction and resolution will be added in a later slice so they can happen together safely.</p></div>
                <label for="resolution-notes">Decision notes</label>
                <textarea id="resolution-notes" rows="4" bind:value={resolutionNotes} placeholder="Example: The official registrar calendar confirms March 20."></textarea>
                <button class="admin-danger-button" type="button" disabled={Boolean(mutation) || resolutionNotes.trim().length < 3} onclick={() => runAction("reject")}>
                  {#if mutation === "reject"}<LoaderCircle class="spinning" size={17} /> Rejecting...{:else}<X size={17} /> Reject report{/if}
                </button>
              </div>
            {:else}
              <div class="admin-decision-card">
                <span>{#if selectedReport.status === "rejected"}<X size={18} />{:else}<Check size={18} />{/if}</span>
                <div><strong>{selectedReport.status === "rejected" ? "Report rejected" : "Report resolved"}</strong><p>{selectedReport.resolutionNotes ?? "No decision notes were recorded."}</p></div>
              </div>
            {/if}
          {/if}
        </section>
      </div>
    </section>

    <a class="admin-back-link light" href="/"><ArrowLeft size={15} /> Back to the public calendar</a>
  {/if}
</main>

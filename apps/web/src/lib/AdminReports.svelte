<script lang="ts">
  import { onMount } from "svelte";
  import { format, parseISO } from "date-fns";
  import {
    AlertTriangle, ArrowLeft, Check, ChevronRight, Clock3, ExternalLink,
    FileImage, FileText, Inbox, LoaderCircle, LockKeyhole, LogOut,
    RefreshCw, School, ShieldCheck, X,
  } from "@lucide/svelte";
  import type {
    AdminEditableActivityPeriod,
    AdminEditableEvent,
    AdminMeResponse,
    AdminReport,
    AdminReportAction,
    AdminReportDetail,
    AdminReportDetailResponse,
    AdminReportResponse,
    AdminReportsResponse,
    AdminReportSourceUrlResponse,
    AdminReportStatus,
  } from "@commondays/shared";
  import { adminFetch, getSupabaseClient } from "./supabase";

  type ApplyCorrectionAction = Extract<AdminReportAction, { action: "apply_correction" }>;
  type Correction = ApplyCorrectionAction["correction"];
  type CorrectionOperation = Correction["operation"];
  type Evidence = { uploadId: string; sourcePage: number | null; rawText: string };

  const tabs: { id: AdminReportStatus; label: string }[] = [
    { id: "submitted", label: "New" },
    { id: "reviewing", label: "Reviewing" },
    { id: "resolved", label: "Resolved" },
    { id: "rejected", label: "Rejected" },
  ];
  const reasonLabels: Record<AdminReport["reason"], string> = {
    wrong_date: "Wrong date", missing_date: "Missing date", wrong_name: "Wrong name", other: "Other issue",
  };
  const eventKindLabels = {
    break: "Break", holiday: "Holiday", no_classes: "No classes", term_boundary: "Derived gap",
  } as const;
  const operationLabels: Record<CorrectionOperation, string> = {
    add_event: "Add a missing calendar event",
    update_event: "Correct an existing calendar event",
    delete_event: "Remove an incorrect calendar event",
    add_period: "Add an instructional/activity period",
    update_period: "Correct an instructional/activity period",
    delete_period: "Remove an instructional/activity period",
  };

  let activeStatus: AdminReportStatus = "submitted";
  let reports: AdminReport[] = [];
  let selectedReport: AdminReport | null = null;
  let reportDetail: AdminReportDetail | null = null;
  let adminEmail = "";
  let resolutionNotes = "";
  let isInitializing = true;
  let isLoadingReports = false;
  let isLoadingDetail = false;
  let mutation: AdminReportAction["action"] | "" = "";
  let loadError = "";
  let actionError = "";
  let accessDenied = false;
  let notice = "";
  let requestNumber = 0;
  let detailRequestNumber = 0;

  let selectedSourceId = "";
  let sourcePreviewUrl = "";
  let sourcePreviewExpiresAt = "";
  let sourcePreviewError = "";
  let isLoadingSource = false;
  let sourceRequestNumber = 0;
  let sourceExpiryTimer: ReturnType<typeof setTimeout> | undefined;

  let correctionOperation: CorrectionOperation | "" = "";
  let targetEventLineageId = "";
  let targetPeriodLineageId = "";
  let correctionName = "";
  let correctionEventKind: "break" | "holiday" | "no_classes" = "break";
  let correctionStartDate = "";
  let correctionEndDate = "";
  let eventEvidenceUploadId = "";
  let eventEvidencePage = "";
  let eventEvidenceRawText = "";
  let periodStartUploadId = "";
  let periodStartPage = "";
  let periodStartRawText = "";
  let periodEndUploadId = "";
  let periodEndPage = "";
  let periodEndRawText = "";
  let correctionConfirmed = false;
  let correctionOperationId = "";
  let correctionAttempted = false;

  const client = getSupabaseClient();

  onMount(() => {
    const subscription = client?.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" && !session) window.location.replace("/admin/login");
    }).data.subscription;
    void initialize();
    return () => {
      subscription?.unsubscribe();
      clearSourcePreview();
    };
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
      handleLoadError(cause);
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

  function handleLoadError(cause: unknown) {
    if (cause instanceof Error && cause.message === "ADMIN_SESSION_REQUIRED") return;
    if (!accessDenied) loadError = cause instanceof Error ? cause.message : "The review queue is unavailable.";
  }
  function handleActionError(cause: unknown) {
    if (cause instanceof Error && cause.message === "ADMIN_SESSION_REQUIRED") return;
    if (!accessDenied) actionError = cause instanceof Error ? cause.message : "That decision could not be saved.";
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
      reportDetail = null;
      resolutionNotes = next?.resolutionNotes ?? "";
      clearSourcePreview();
      if (next) await loadReportDetail(next.id, currentRequest);
    } catch (cause) {
      handleLoadError(cause);
    } finally {
      if (currentRequest === requestNumber) isLoadingReports = false;
    }
  }

  async function loadReportDetail(id: string, parentRequest = requestNumber) {
    const detailRequest = ++detailRequestNumber;
    isLoadingDetail = true;
    try {
      const body = await request<AdminReportDetailResponse>(`/api/v1/admin/reports/${id}`);
      if (parentRequest !== requestNumber || detailRequest !== detailRequestNumber) return;
      selectedReport = body.report;
      reportDetail = body.report;
      resolutionNotes = body.report.resolutionNotes ?? "";
      selectedSourceId = body.report.sourceFiles[0]?.id ?? "";
      initializeCorrection(body.report);
    } catch (cause) {
      handleLoadError(cause);
    } finally {
      if (parentRequest === requestNumber && detailRequest === detailRequestNumber) isLoadingDetail = false;
    }
  }

  async function selectStatus(status: AdminReportStatus) {
    if (status === activeStatus && !loadError) return;
    activeStatus = status;
    notice = "";
    actionError = "";
    clearSourcePreview();
    await loadReports(status);
  }
  async function selectReport(report: AdminReport) {
    selectedReport = report;
    reportDetail = null;
    resolutionNotes = report.resolutionNotes ?? "";
    notice = "";
    actionError = "";
    clearSourcePreview();
    await loadReportDetail(report.id);
  }

  async function runAction(action: "start_review" | "reject") {
    if (!selectedReport || mutation) return;
    const actionBody: AdminReportAction = action === "start_review"
      ? { action }
      : { action, resolutionNotes: resolutionNotes.trim() };
    if (action === "reject" && resolutionNotes.trim().length < 3) return;
    mutation = action;
    actionError = "";
    try {
      const body = await request<AdminReportResponse>(`/api/v1/admin/reports/${selectedReport.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(actionBody),
      });
      notice = body.message ?? (action === "start_review" ? "Review started." : "Report rejected.");
      activeStatus = body.report.status;
      await loadReports(activeStatus, body.report.id);
    } catch (cause) {
      handleActionError(cause);
    } finally {
      mutation = "";
    }
  }

  function clearSourcePreview(message = "") {
    sourceRequestNumber += 1;
    if (sourceExpiryTimer) clearTimeout(sourceExpiryTimer);
    sourceExpiryTimer = undefined;
    sourcePreviewUrl = "";
    sourcePreviewExpiresAt = "";
    sourcePreviewError = message;
    isLoadingSource = false;
  }
  function chooseSourceFile(id: string) {
    if (id === selectedSourceId) return;
    selectedSourceId = id;
    clearSourcePreview();
  }
  async function openSourcePreview() {
    if (!reportDetail || !selectedSourceId || isLoadingSource) return;
    clearSourcePreview();
    const sourceRequest = ++sourceRequestNumber;
    isLoadingSource = true;
    try {
      const body = await request<AdminReportSourceUrlResponse>(
        `/api/v1/admin/reports/${reportDetail.id}/source-files/${selectedSourceId}/signed-url`,
        { method: "POST" },
      );
      if (sourceRequest !== sourceRequestNumber) return;
      sourcePreviewUrl = body.url;
      sourcePreviewExpiresAt = body.expiresAt;
      const delay = Math.max(0, Date.parse(body.expiresAt) - Date.now());
      sourceExpiryTimer = setTimeout(() => {
        if (sourceRequest === sourceRequestNumber) clearSourcePreview("This secure preview expired. Open it again to keep reviewing.");
      }, Math.min(delay, 2_147_000_000));
    } catch (cause) {
      if (sourceRequest === sourceRequestNumber) sourcePreviewError = cause instanceof Error ? cause.message : "The source preview is unavailable.";
    } finally {
      if (sourceRequest === sourceRequestNumber) isLoadingSource = false;
    }
  }

  function makeOperationId() { return crypto.randomUUID(); }
  function markCorrectionEdited() {
    correctionAttempted = false;
    correctionOperationId = makeOperationId();
  }
  function correctionOptions(detail: AdminReportDetail) {
    if (isDerivedReport(detail)) {
      const periodOptions: CorrectionOperation[] = ["add_period"];
      if (detail.currentPeriods.length > 0) periodOptions.unshift("update_period");
      if (detail.currentPeriods.length > 1) periodOptions.push("delete_period");
      return periodOptions;
    }
    const options: CorrectionOperation[] = ["add_event"];
    if (editableEvents(detail).length > 0) options.push("update_event", "delete_event");
    options.push("add_period");
    if (detail.currentPeriods.length > 0) options.push("update_period");
    if (detail.currentPeriods.length > 1) options.push("delete_period");
    return options;
  }
  function editableEvents(detail: AdminReportDetail) {
    return detail.currentEvents.filter((event) => !event.isDerived);
  }
  function isDerivedReport(detail: AdminReportDetail) {
    return detail.eventKind === "term_boundary" || detail.currentEvent?.isDerived === true;
  }
  function initializeCorrection(detail: AdminReportDetail) {
    targetEventLineageId = !detail.currentEvent?.isDerived
      ? detail.currentEvent?.lineageId ?? editableEvents(detail)[0]?.lineageId ?? ""
      : editableEvents(detail)[0]?.lineageId ?? "";
    targetPeriodLineageId = closestPeriod(detail)?.lineageId ?? "";
    eventEvidenceUploadId = detail.currentEvent?.sourceUploadId ?? detail.sourceFiles[0]?.id ?? "";
    periodStartUploadId = detail.sourceFiles[0]?.id ?? "";
    periodEndUploadId = detail.sourceFiles[0]?.id ?? "";
    const defaultOperation: CorrectionOperation = isDerivedReport(detail)
      ? (detail.currentPeriods.length > 0 ? "update_period" : "add_period")
      : detail.reason === "missing_date" || !detail.currentEvent ? "add_event" : "update_event";
    selectCorrectionOperation(defaultOperation, false);
    correctionConfirmed = false;
    correctionAttempted = false;
    correctionOperationId = makeOperationId();
  }
  function closestPeriod(detail: AdminReportDetail) {
    if (detail.currentPeriods.length === 0) return undefined;
    const start = detail.eventStartDate;
    if (!start) return detail.currentPeriods[0];
    return detail.currentPeriods.find((period) => period.startDate <= start && period.endDate >= start)
      ?? detail.currentPeriods.find((period) => period.startDate >= start)
      ?? detail.currentPeriods[detail.currentPeriods.length - 1];
  }
  function selectCorrectionOperation(operation: CorrectionOperation, edited = true) {
    correctionOperation = operation;
    correctionConfirmed = false;
    if (operation === "update_event" || operation === "delete_event") {
      const currentLineage = reportDetail?.currentEvent && !reportDetail.currentEvent.isDerived ? reportDetail.currentEvent.lineageId : "";
      selectEventTarget(currentLineage || (reportDetail ? editableEvents(reportDetail)[0]?.lineageId : "") || "", false);
    } else if (operation === "add_event") {
      correctionName = selectedReport?.eventName ?? "";
      correctionEventKind = selectedReport?.eventKind && selectedReport.eventKind !== "term_boundary" ? selectedReport.eventKind : "break";
      correctionStartDate = selectedReport?.eventStartDate ?? "";
      correctionEndDate = selectedReport?.eventEndDate ?? selectedReport?.eventStartDate ?? "";
      eventEvidenceRawText = "";
      eventEvidencePage = "";
    } else if (operation === "update_period" || operation === "delete_period") {
      selectPeriodTarget(targetPeriodLineageId || (reportDetail ? closestPeriod(reportDetail)?.lineageId : "") || "", false);
    } else {
      correctionName = "";
      correctionStartDate = "";
      correctionEndDate = "";
      periodStartRawText = "";
      periodStartPage = "";
      periodEndRawText = "";
      periodEndPage = "";
    }
    if (edited) markCorrectionEdited();
  }
  function selectEventTarget(lineageId: string, edited = true) {
    targetEventLineageId = lineageId;
    const event = reportDetail ? editableEvents(reportDetail).find((item) => item.lineageId === lineageId) : undefined;
    if (event) populateEvent(event);
    correctionConfirmed = false;
    if (edited) markCorrectionEdited();
  }
  function populateEvent(event: AdminEditableEvent) {
    correctionName = event.name;
    correctionEventKind = event.kind === "term_boundary" ? "break" : event.kind;
    correctionStartDate = event.startDate;
    correctionEndDate = event.endDate;
    eventEvidenceUploadId = event.sourceUploadId ?? "";
    eventEvidencePage = event.sourcePage?.toString() ?? "";
    eventEvidenceRawText = event.rawText ?? "";
  }
  function selectPeriodTarget(lineageId: string, edited = true) {
    targetPeriodLineageId = lineageId;
    const period = reportDetail?.currentPeriods.find((item) => item.lineageId === lineageId);
    if (period) populatePeriod(period);
    correctionConfirmed = false;
    if (edited) markCorrectionEdited();
  }
  function populatePeriod(period: AdminEditableActivityPeriod) {
    correctionName = period.name;
    correctionStartDate = period.startDate;
    correctionEndDate = period.endDate;
    periodStartUploadId = period.startSourceUploadId ?? "";
    periodStartPage = period.startSourcePage?.toString() ?? "";
    periodStartRawText = period.startRawText;
    periodEndUploadId = period.endSourceUploadId ?? "";
    periodEndPage = period.endSourcePage?.toString() ?? "";
    periodEndRawText = period.endRawText;
  }

  function sourceFile(id: string) { return reportDetail?.sourceFiles.find((file) => file.id === id); }
  function evidence(uploadId: string, page: string, rawText: string): Evidence | undefined {
    if (!uploadId || !rawText.trim()) return undefined;
    const file = sourceFile(uploadId);
    if (!file) return undefined;
    return { uploadId, sourcePage: file.fileType === "pdf" ? Number(page) : null, rawText: rawText.trim() };
  }
  function evidenceProblem(uploadId: string, page: string, rawText: string, required: boolean) {
    const hasAny = Boolean(page.trim() || rawText.trim());
    if (!required && !uploadId) return "";
    if (!required && !hasAny) return "";
    if (!uploadId || !sourceFile(uploadId)) return "Choose the source file that supports this date.";
    if (!rawText.trim()) return "Enter the exact source text that supports this date.";
    if (sourceFile(uploadId)?.fileType === "pdf" && (!/^\d+$/.test(page) || Number(page) < 1)) return "Enter a valid PDF page number.";
    return "";
  }
  function correctionProblem() {
    if (!reportDetail || !correctionOperation) return "Choose the correction you want to make.";
    if (resolutionNotes.trim().length < 3) return "Add decision notes explaining what you verified.";
    if (!correctionConfirmed) return "Confirm that you verified the change against the official source.";
    if (correctionOperation === "delete_event") return targetEventLineageId ? "" : "Choose the calendar event to remove.";
    if (correctionOperation === "delete_period") return targetPeriodLineageId ? "" : "Choose the activity period to remove.";
    if (!correctionName.trim()) return "Enter a name for the corrected item.";
    if (!correctionStartDate || !correctionEndDate) return "Enter both the start and end date.";
    if (correctionEndDate < correctionStartDate) return "The end date cannot be before the start date.";
    if (correctionOperation === "update_event" && !targetEventLineageId) return "Choose the calendar event to correct.";
    if (correctionOperation === "update_period" && !targetPeriodLineageId) return "Choose the activity period to correct.";
    if (correctionOperation === "add_period") {
      return evidenceProblem(periodStartUploadId, periodStartPage, periodStartRawText, true)
        || evidenceProblem(periodEndUploadId, periodEndPage, periodEndRawText, true);
    }
    if (correctionOperation === "update_period") {
      return evidenceProblem(periodStartUploadId, periodStartPage, periodStartRawText, false)
        || evidenceProblem(periodEndUploadId, periodEndPage, periodEndRawText, false);
    }
    return evidenceProblem(
      eventEvidenceUploadId,
      eventEvidencePage,
      eventEvidenceRawText,
      correctionOperation === "add_event",
    );
  }

  function buildCorrection(): Correction | null {
    if (!correctionOperation) return null;
    const eventEvidence = evidence(eventEvidenceUploadId, eventEvidencePage, eventEvidenceRawText);
    const startEvidence = evidence(periodStartUploadId, periodStartPage, periodStartRawText);
    const endEvidence = evidence(periodEndUploadId, periodEndPage, periodEndRawText);
    switch (correctionOperation) {
      case "add_event":
        if (!eventEvidence) return null;
        return { operation: "add_event", name: correctionName.trim(), kind: correctionEventKind, startDate: correctionStartDate, endDate: correctionEndDate, evidence: eventEvidence };
      case "update_event": return { operation: "update_event", targetLineageId: targetEventLineageId, name: correctionName.trim(), kind: correctionEventKind, startDate: correctionStartDate, endDate: correctionEndDate, ...(eventEvidence ? { evidence: eventEvidence } : {}) };
      case "delete_event": return { operation: "delete_event", targetLineageId: targetEventLineageId };
      case "add_period":
        if (!startEvidence || !endEvidence) return null;
        return { operation: "add_period", name: correctionName.trim(), startDate: correctionStartDate, endDate: correctionEndDate, startEvidence, endEvidence };
      case "update_period": return { operation: "update_period", targetLineageId: targetPeriodLineageId, name: correctionName.trim(), startDate: correctionStartDate, endDate: correctionEndDate, ...(startEvidence ? { startEvidence } : {}), ...(endEvidence ? { endEvidence } : {}) };
      case "delete_period": return { operation: "delete_period", targetLineageId: targetPeriodLineageId };
    }
  }

  async function applyCorrection() {
    if (!reportDetail || mutation) return;
    correctionAttempted = true;
    const problem = correctionProblem();
    const correction = buildCorrection();
    if (problem || !correction) return;
    const actionBody: ApplyCorrectionAction = {
      action: "apply_correction",
      operationId: correctionOperationId,
      expectedCalendarId: reportDetail.currentCalendar.id,
      expectedCalendarVersion: reportDetail.currentCalendar.version,
      resolutionNotes: resolutionNotes.trim(),
      correction,
    };
    mutation = "apply_correction";
    actionError = "";
    try {
      const body = await request<AdminReportResponse>(`/api/v1/admin/reports/${reportDetail.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(actionBody),
      });
      notice = body.message ?? "Correction published and report resolved.";
      activeStatus = body.report.status;
      await loadReports(activeStatus, body.report.id);
    } catch (cause) {
      handleActionError(cause);
    } finally {
      mutation = "";
    }
  }

  async function signOut() {
    clearSourcePreview();
    await client?.auth.signOut({ scope: "local" });
    window.location.replace("/admin/login");
  }
  function displayDate(value: string) {
    try { return format(parseISO(value), "MMM d, yyyy"); } catch { return value; }
  }
  function dateRange(startDate: string | null, endDate: string | null) {
    if (!startDate) return "No event selected";
    if (!endDate || endDate === startDate) return displayDate(startDate);
    return `${displayDate(startDate)} to ${displayDate(endDate)}`;
  }
  function selectedSource() { return reportDetail?.sourceFiles.find((file) => file.id === selectedSourceId) ?? null; }
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
      <p>Verify student reports against their source files. A correction only goes live after you approve it here.</p>
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
      {#if actionError}<div class="admin-load-error" role="alert"><AlertTriangle size={17} /> <span>{actionError}</span></div>{/if}

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
              <div class="admin-detail-block historical">
                <span><Clock3 size={14} /> REPORTED VERSION {reportDetail?.reportedCalendar.version ?? "…"}</span>
                <strong>{selectedReport.eventName ?? "No specific event selected"}</strong>
                <p>{dateRange(selectedReport.eventStartDate, selectedReport.eventEndDate)}</p>
                {#if selectedReport.eventKind}<small>{eventKindLabels[selectedReport.eventKind]}</small>{/if}
              </div>
              <div class="admin-detail-block current">
                <span><School size={14} /> LIVE VERSION {reportDetail?.currentCalendar.version ?? "…"}</span>
                {#if reportDetail?.currentEvent}
                  <strong>{reportDetail.currentEvent.name}</strong>
                  <p>{dateRange(reportDetail.currentEvent.startDate, reportDetail.currentEvent.endDate)}</p>
                  <small>{eventKindLabels[reportDetail.currentEvent.kind]}</small>
                {:else}
                  <strong>No matching event in the live version</strong>
                  <p>The reported item may already have changed. Review the current entries before applying another correction.</p>
                {/if}
              </div>
            </div>

            {#if reportDetail}
              <section class="admin-source-panel" aria-labelledby="source-files-heading">
                <header>
                  <div><span>OFFICIAL SOURCE</span><strong id="source-files-heading">Verify the calendar file</strong></div>
                  {#if sourcePreviewExpiresAt}<small>Secure link expires {format(parseISO(sourcePreviewExpiresAt), "h:mm:ss a")}</small>{/if}
                </header>
                {#if reportDetail.sourceFiles.length === 0}
                  <div class="admin-source-empty"><AlertTriangle size={18} /><span><strong>No source file available</strong><small>A correction cannot add new evidence until the original upload is available.</small></span></div>
                {:else}
                  <div class="admin-source-files" role="list" aria-label="Uploaded calendar files">
                    {#each reportDetail.sourceFiles as file (file.id)}
                      <button type="button" class:active={selectedSourceId === file.id} aria-pressed={selectedSourceId === file.id} onclick={() => chooseSourceFile(file.id)}>
                        {#if file.fileType === "pdf"}<FileText size={17} />{:else}<FileImage size={17} />{/if}
                        <span><strong>{file.originalFilename}</strong><small>{file.fileType === "pdf" ? "PDF" : `Screenshot ${file.position}`}</small></span>
                      </button>
                    {/each}
                  </div>
                  <button class="admin-secondary-button admin-preview-button" type="button" onclick={openSourcePreview} disabled={isLoadingSource}>
                    {#if isLoadingSource}<LoaderCircle class="spinning" size={16} /> Opening secure preview...{:else}<ExternalLink size={16} /> {sourcePreviewUrl ? "Refresh secure preview" : "Open secure preview"}{/if}
                  </button>
                  {#if sourcePreviewError}<p class="admin-source-error" role="alert">{sourcePreviewError}</p>{/if}
                  {#if sourcePreviewUrl && selectedSource()}
                    <div class="admin-source-preview">
                      {#if selectedSource()?.fileType === "image"}
                        <img src={sourcePreviewUrl} referrerpolicy="no-referrer" alt={`Academic calendar source: ${selectedSource()?.originalFilename}`} />
                      {:else}
                        <iframe src={sourcePreviewUrl} referrerpolicy="no-referrer" title={`Academic calendar source: ${selectedSource()?.originalFilename}`}></iframe>
                      {/if}
                    </div>
                  {/if}
                {/if}
              </section>
            {/if}

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
            {:else if selectedReport.status === "reviewing" && reportDetail}
              <section class="admin-correction-panel" aria-labelledby="correction-heading">
                <header>
                  <span>VERIFIED CORRECTION</span>
                  <h3 id="correction-heading">Create the next live calendar version</h3>
                  <p>The current version stays in history. This publishes a corrected copy and resolves the report in one step.</p>
                </header>

                {#if isDerivedReport(reportDetail)}
                  <div class="admin-derived-note"><AlertTriangle size={18} /><span><strong>This is a derived free-time gap.</strong><small>Correct the instructional/activity period that created it. Common Days will regenerate the gap automatically.</small></span></div>
                {/if}

                <div class="admin-form-field wide">
                  <label for="correction-operation">Correction type</label>
                  <select id="correction-operation" value={correctionOperation} onchange={(event) => selectCorrectionOperation((event.currentTarget as HTMLSelectElement).value as CorrectionOperation)}>
                    {#each correctionOptions(reportDetail) as operation}<option value={operation}>{operationLabels[operation]}</option>{/each}
                  </select>
                </div>

                {#if correctionOperation === "update_event" || correctionOperation === "delete_event"}
                  <div class="admin-form-field wide">
                    <label for="event-target">Live event</label>
                    <select id="event-target" value={targetEventLineageId} onchange={(event) => selectEventTarget((event.currentTarget as HTMLSelectElement).value)}>
                      {#each editableEvents(reportDetail) as event}<option value={event.lineageId}>{event.name} · {dateRange(event.startDate, event.endDate)}</option>{/each}
                    </select>
                  </div>
                {:else if correctionOperation === "update_period" || correctionOperation === "delete_period"}
                  <div class="admin-form-field wide">
                    <label for="period-target">Live instructional/activity period</label>
                    <select id="period-target" value={targetPeriodLineageId} onchange={(event) => selectPeriodTarget((event.currentTarget as HTMLSelectElement).value)}>
                      {#each reportDetail.currentPeriods as period}<option value={period.lineageId}>{period.name} · {dateRange(period.startDate, period.endDate)}</option>{/each}
                    </select>
                  </div>
                {/if}

                {#if correctionOperation !== "delete_event" && correctionOperation !== "delete_period"}
                  <div class="admin-form-grid">
                    <div class="admin-form-field wide">
                      <label for="correction-name">Name</label>
                      <input id="correction-name" maxlength="160" bind:value={correctionName} oninput={markCorrectionEdited} />
                    </div>
                    {#if correctionOperation === "add_event" || correctionOperation === "update_event"}
                      <div class="admin-form-field wide">
                        <label for="correction-kind">Event type</label>
                        <select id="correction-kind" bind:value={correctionEventKind} onchange={markCorrectionEdited}>
                          <option value="break">Break</option><option value="holiday">Holiday</option><option value="no_classes">No classes</option>
                        </select>
                      </div>
                    {/if}
                    <div class="admin-form-field"><label for="correction-start">Start date</label><input id="correction-start" type="date" bind:value={correctionStartDate} oninput={markCorrectionEdited} /></div>
                    <div class="admin-form-field"><label for="correction-end">End date</label><input id="correction-end" type="date" bind:value={correctionEndDate} oninput={markCorrectionEdited} /></div>
                  </div>

                  {#if correctionOperation === "add_event" || correctionOperation === "update_event"}
                    <fieldset class="admin-evidence-fieldset">
                      <legend>Source evidence <span>{correctionOperation === "update_event" ? "optional when the existing evidence is unchanged" : "required for a new event"}</span></legend>
                      <div class="admin-form-grid">
                        <div class="admin-form-field wide">
                          <label for="event-evidence-file">Source file</label>
                          <select id="event-evidence-file" bind:value={eventEvidenceUploadId} onchange={markCorrectionEdited}>
                            <option value="">Keep existing evidence</option>
                            {#each reportDetail.sourceFiles as file}<option value={file.id}>{file.originalFilename}</option>{/each}
                          </select>
                        </div>
                        {#if sourceFile(eventEvidenceUploadId)?.fileType === "pdf"}
                          <div class="admin-form-field"><label for="event-evidence-page">PDF page</label><input id="event-evidence-page" type="number" min="1" bind:value={eventEvidencePage} oninput={markCorrectionEdited} /></div>
                        {/if}
                        <div class="admin-form-field wide"><label for="event-evidence-text">Exact source text</label><textarea id="event-evidence-text" rows="2" maxlength="4000" bind:value={eventEvidenceRawText} oninput={markCorrectionEdited}></textarea></div>
                      </div>
                    </fieldset>
                  {:else}
                    <div class="admin-period-evidence-grid">
                      <fieldset class="admin-evidence-fieldset">
                        <legend>Start-date evidence</legend>
                        <div class="admin-form-field"><label for="period-start-file">Source file</label><select id="period-start-file" bind:value={periodStartUploadId} onchange={markCorrectionEdited}><option value="">Keep existing evidence</option>{#each reportDetail.sourceFiles as file}<option value={file.id}>{file.originalFilename}</option>{/each}</select></div>
                        {#if sourceFile(periodStartUploadId)?.fileType === "pdf"}<div class="admin-form-field"><label for="period-start-page">PDF page</label><input id="period-start-page" type="number" min="1" bind:value={periodStartPage} oninput={markCorrectionEdited} /></div>{/if}
                        <div class="admin-form-field"><label for="period-start-text">Exact source text</label><textarea id="period-start-text" rows="2" maxlength="4000" bind:value={periodStartRawText} oninput={markCorrectionEdited}></textarea></div>
                      </fieldset>
                      <fieldset class="admin-evidence-fieldset">
                        <legend>End-date evidence</legend>
                        <div class="admin-form-field"><label for="period-end-file">Source file</label><select id="period-end-file" bind:value={periodEndUploadId} onchange={markCorrectionEdited}><option value="">Keep existing evidence</option>{#each reportDetail.sourceFiles as file}<option value={file.id}>{file.originalFilename}</option>{/each}</select></div>
                        {#if sourceFile(periodEndUploadId)?.fileType === "pdf"}<div class="admin-form-field"><label for="period-end-page">PDF page</label><input id="period-end-page" type="number" min="1" bind:value={periodEndPage} oninput={markCorrectionEdited} /></div>{/if}
                        <div class="admin-form-field"><label for="period-end-text">Exact source text</label><textarea id="period-end-text" rows="2" maxlength="4000" bind:value={periodEndRawText} oninput={markCorrectionEdited}></textarea></div>
                      </fieldset>
                    </div>
                  {/if}
                {:else}
                  <div class="admin-delete-warning"><AlertTriangle size={18} /><span><strong>This removes the selected item from the next version.</strong><small>The current published version remains preserved in history.</small></span></div>
                {/if}

                <div class="admin-form-field wide"><label for="resolution-notes">Decision notes</label><textarea id="resolution-notes" rows="4" maxlength="1000" bind:value={resolutionNotes} oninput={markCorrectionEdited} placeholder="Describe what the official source confirms and why this is the correct change."></textarea></div>
                <label class="admin-confirmation" for="correction-confirmed">
                  <input id="correction-confirmed" type="checkbox" bind:checked={correctionConfirmed} onchange={markCorrectionEdited} />
                  <span><strong>I verified this correction against the official source.</strong><small>Publishing will replace live version {reportDetail.currentCalendar.version} with a new reviewed version.</small></span>
                </label>
                {#if correctionAttempted && correctionProblem()}<p class="admin-inline-error" role="alert">{correctionProblem()}</p>{/if}
                <div class="admin-correction-actions">
                  <button class="admin-primary-button compact" type="button" disabled={Boolean(mutation)} onclick={applyCorrection}>
                    {#if mutation === "apply_correction"}<LoaderCircle class="spinning" size={17} /> Publishing...{:else}<Check size={17} /> Publish correction & resolve{/if}
                  </button>
                  <button class="admin-danger-button" type="button" disabled={Boolean(mutation) || resolutionNotes.trim().length < 3} onclick={() => runAction("reject")}>
                    {#if mutation === "reject"}<LoaderCircle class="spinning" size={17} /> Rejecting...{:else}<X size={17} /> Reject report instead{/if}
                  </button>
                </div>
              </section>
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

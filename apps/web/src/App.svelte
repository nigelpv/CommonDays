<script lang="ts">
  import { onMount } from "svelte";
  import {
    addMonths,
    eachDayOfInterval,
    endOfMonth,
    format,
    isWithinInterval,
    parseISO,
    startOfMonth,
    subMonths,
  } from "date-fns";
  import { AlertTriangle, ArrowLeft, ArrowRight, Check, Plus, Sparkles, X } from "@lucide/svelte";
  import { getAcademicYearDateWindow } from "@commondays/shared/academic-year";
  import type { CalendarComparison, CalendarEvent, School } from "@commondays/shared";
  import AddSchoolModal from "./lib/AddSchoolModal.svelte";
  import { apiFetch } from "./lib/api.js";

  const academicYear = "2026-27";
  const academicYearWindow = getAcademicYearDateWindow(academicYear);
  const initialCalendarDate = new Date(Number(academicYear.slice(0, 4)), 7, 1);
  const weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

  let comparison: CalendarComparison | null = null;
  let allSchools: School[] = [];
  let selectedIds: string[] = [];
  let activeMonth = startOfMonth(initialCalendarDate);
  let selectedDate = initialCalendarDate;
  let isLoading = true;
  let error = "";
  let comparisonError = "";
  let comparisonUpdating = false;
  let schoolPickerOpen = false;
  let reportOpen = false;
  let reportSchool: School | null = null;
  let reportDetails = "";
  let reportStatus = "";
  let reportSubmitting = false;
  let reportSucceeded = false;
  let reportRequestNumber = 0;

  $: selectedSchools = selectedIds.flatMap((schoolId) => {
    const school = comparison?.schools.find((candidate) => candidate.id === schoolId);
    return school ? [school] : [];
  });
  $: monthStart = startOfMonth(activeMonth);
  $: monthDays = eachDayOfInterval({ start: monthStart, end: endOfMonth(activeMonth) });
  $: leadingDays = Array(monthStart.getDay()).fill(null);
  $: bestWindow = findBestWindow(comparison?.events ?? [], selectedIds);

  onMount(async () => {
    try {
      await loadSchools();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not load Common Days";
    } finally {
      isLoading = false;
    }
  });

  async function loadSchools() {
    const schoolResponse = await apiFetch("/api/v1/schools");
    if (!schoolResponse.ok) throw new Error("School library unavailable");
    const schoolBody = (await schoolResponse.json()) as { schools: School[] };
    allSchools = schoolBody.schools;
  }

  function upsertSchool(school: School) {
    const withoutSchool = allSchools.filter((candidate) => candidate.id !== school.id);
    allSchools = [...withoutSchool, school].sort((left, right) => left.name.localeCompare(right.name));
  }

  async function requestComparison(schoolIds: string[]) {
    if (schoolIds.length === 0) return null;

    const params = new URLSearchParams({ year: academicYear, schools: schoolIds.join(",") });
    const response = await apiFetch(`/api/v1/calendars?${params}`);
    if (!response.ok) throw new Error("Calendar comparison unavailable");
    const nextComparison = (await response.json()) as CalendarComparison;
    const availableIds = new Set(nextComparison.schools.map((school) => school.id));
    const unavailableIds = schoolIds.filter((schoolId) => !availableIds.has(schoolId));
    if (unavailableIds.length > 0) {
      const unavailableSet = new Set(unavailableIds);
      const unavailableSchool = allSchools.find((candidate) => candidate.id === unavailableIds[0]);
      allSchools = allSchools.map((candidate) => unavailableSet.has(candidate.id)
        ? { ...candidate, availableYears: candidate.availableYears.filter((year) => year !== academicYear) }
        : candidate);

      // Reconcile schools that were already selected so an old response can
      // never leave an unpublished calendar visibly labeled as available.
      const retainedIds = selectedIds.filter((schoolId) => availableIds.has(schoolId));
      const retainedSet = new Set(retainedIds);
      selectedIds = retainedIds;
      comparison = retainedIds.length === 0
        ? null
        : {
            ...nextComparison,
            schools: nextComparison.schools.filter((school) => retainedSet.has(school.id)),
            events: nextComparison.events.filter((event) => retainedSet.has(event.schoolId)),
          };
      if (retainedIds.length === 0) resetCalendarView();
      throw new Error(`${unavailableSchool?.shortName ?? "That school"} ${academicYear} is no longer available. Check the calendar again.`);
    }
    return nextComparison;
  }

  async function addSchool(id: string) {
    comparisonError = "";
    await loadSchools();
    if (selectedIds.includes(id)) return;

    const nextSelectedIds = [...selectedIds, id];
    const nextComparison = await requestComparison(nextSelectedIds);
    if (!nextComparison) return;

    if (selectedIds.length === 0) resetCalendarView();
    selectedIds = nextSelectedIds;
    comparison = nextComparison;
    schoolPickerOpen = false;
  }

  async function removeSchool(id: string) {
    if (comparisonUpdating) return;
    comparisonUpdating = true;
    comparisonError = "";
    try {
      const nextSelectedIds = selectedIds.filter((schoolId) => schoolId !== id);
      if (nextSelectedIds.length === 0) {
        selectedIds = [];
        comparison = null;
        resetCalendarView();
        return;
      }

      const nextComparison = await requestComparison(nextSelectedIds);
      if (!nextComparison) return;
      selectedIds = nextSelectedIds;
      comparison = nextComparison;
    } catch (cause) {
      comparisonError = cause instanceof Error ? cause.message : "Could not update this comparison.";
    } finally {
      comparisonUpdating = false;
    }
  }

  function resetCalendarView() {
    activeMonth = startOfMonth(initialCalendarDate);
    selectedDate = initialCalendarDate;
  }

  function eventsForDate(date: Date) {
    return (comparison?.events ?? []).filter((event) =>
      isWithinInterval(date, { start: parseISO(event.startDate), end: parseISO(event.endDate) }),
    );
  }

  function schoolIsOff(schoolId: string, date: Date) {
    return eventsForDate(date).some((event) => event.schoolId === schoolId);
  }

  function everyoneIsOff(date: Date) {
    return selectedIds.length > 0 && selectedIds.every((id) => schoolIsOff(id, date));
  }

  function openReport(school: School) {
    reportRequestNumber += 1;
    reportSchool = school;
    reportDetails = "";
    reportStatus = "";
    reportSubmitting = false;
    reportSucceeded = false;
    reportOpen = true;
  }

  function closeReport() {
    reportRequestNumber += 1;
    reportOpen = false;
    reportSchool = null;
  }

  async function submitReport() {
    if (!reportSchool || reportDetails.trim().length < 10 || reportSubmitting || reportSucceeded) return;
    const school = reportSchool;
    const currentRequest = ++reportRequestNumber;
    reportSubmitting = true;
    reportStatus = "";
    try {
      const response = await apiFetch("/api/v1/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schoolId: school.id,
          academicYear,
          reason: "other",
          details: reportDetails,
        }),
      });
      if (currentRequest !== reportRequestNumber || !reportOpen || reportSchool?.id !== school.id) return;
      reportSucceeded = response.ok;
      reportStatus = response.ok ? "Report submitted for review." : "That report could not be submitted.";
    } catch {
      if (currentRequest !== reportRequestNumber || !reportOpen || reportSchool?.id !== school.id) return;
      reportSucceeded = false;
      reportStatus = "That report could not be submitted.";
    } finally {
      if (currentRequest === reportRequestNumber) reportSubmitting = false;
    }
  }

  function findBestWindow(events: CalendarEvent[], schoolIds: string[]) {
    if (!events.length || !schoolIds.length) return null;
    const dates = eachDayOfInterval({
      start: parseISO(academicYearWindow.startDate),
      end: parseISO(academicYearWindow.endDate),
    });
    let best: Date[] = [];
    let current: Date[] = [];

    for (const date of dates) {
      const off = schoolIds.every((id) =>
        events.some((event) => event.schoolId === id && isWithinInterval(date, {
          start: parseISO(event.startDate),
          end: parseISO(event.endDate),
        })),
      );
      if (off) {
        current = [...current, date];
        if (current.length > best.length) best = current;
      } else {
        current = [];
      }
    }

    return best.length ? { start: best[0], end: best[best.length - 1], days: best.length } : null;
  }
</script>

<svelte:head>
  <title>Common Days | Find the break everyone shares</title>
</svelte:head>

<main>
  <header class="site-header">
    <a class="brand" href="/" aria-label="Common Days home">
      <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
      <span>COMMON DAYS</span>
    </a>
    <div class="header-status"><span></span> Building the shared calendar library</div>
  </header>

  <section class="intro" aria-labelledby="page-title">
    <div>
      <span class="eyebrow">ACADEMIC CALENDAR COMPARISON</span>
      <h1 id="page-title">Find the days<br /><em>everyone shares.</em></h1>
    </div>
    <div class="intro-copy">
      <p>Add each friend&apos;s school. Common Days lines up their official academic calendars and marks the exact dates everyone is free.</p>
      <div class="library-note"><Sparkles size={18} /><span>One upload makes a school year reusable for everyone.</span></div>
    </div>
  </section>

  <section class="product-shell" aria-label="Common Days calendar application">
    <div class="window-bar">
      <div class="window-dots" aria-hidden="true"><i></i><i></i><i></i></div>
      <span>COMMON DAYS CALENDAR</span>
    </div>

    {#if isLoading}
      <div class="state-panel" role="status" aria-live="polite"><Sparkles class="spin" size={24} /> Loading the school library...</div>
    {:else if error}
      <div class="state-panel error" role="alert"><AlertTriangle size={24} /> {error}. Make sure the API is running.</div>
    {:else}
      <div class="app-grid">
        <aside class="sidebar">
          <div class="group-heading">
            <div>
              <span>YOUR SCHOOLS</span>
              <h2>{selectedSchools.length === 0 ? "No schools yet" : `${selectedSchools.length} ${selectedSchools.length === 1 ? "school" : "schools"}`}</h2>
            </div>
            <button class="round-button" aria-label="Add a school" disabled={comparisonUpdating} onclick={() => (schoolPickerOpen = true)}><Plus size={19} /></button>
          </div>

          {#if comparisonError}<p class="sidebar-error" role="alert">{comparisonError}</p>{/if}

          <div class="school-list">
            {#each selectedSchools as school (school.id)}
              <article class="school-card">
                <span class="school-avatar" style:background={school.color}>{school.initials}</span>
                <div><strong>{school.shortName}</strong><small>{academicYear} · Available</small></div>
                <div class="school-actions">
                  <button disabled={comparisonUpdating} onclick={() => openReport(school)}>Report</button>
                  <button disabled={comparisonUpdating} aria-label={`Remove ${school.shortName}`} onclick={() => removeSchool(school.id)}><X size={13} /></button>
                </div>
              </article>
            {/each}
          </div>

          {#if selectedSchools.length > 0}
            <button class="add-school" disabled={comparisonUpdating} onclick={() => (schoolPickerOpen = true)}><Plus size={17} /> Add another school</button>
          {:else}
            <p class="sidebar-empty-copy">Choose a school to begin your {academicYear} comparison.</p>
            <button class="add-school first-school" onclick={() => (schoolPickerOpen = true)}><Plus size={17} /> Add your first school</button>
          {/if}
        </aside>

        <section class:empty={selectedIds.length === 0} class="calendar-panel">
          {#if selectedIds.length === 0}
            <div class="empty-comparison">
              <span class="empty-comparison-icon"><Sparkles size={29} /></span>
              <span class="empty-comparison-kicker">START A COMPARISON</span>
              <h2>Add your first school.</h2>
              <p>Choose a school for {academicYear}. If its calendar is already in the library, we will add it. Otherwise, upload multiple screenshots or one official PDF.</p>
              <button class="empty-comparison-cta" onclick={() => (schoolPickerOpen = true)}><Plus size={18} /> Choose a school</button>
            </div>
          {:else if comparison}
            <div class="calendar-title">
              <div><span>ACADEMIC YEAR {academicYear}</span><h2>When is everyone free?</h2></div>
            </div>

            {#if bestWindow}
              <button class="best-window" onclick={() => { activeMonth = startOfMonth(bestWindow!.start); selectedDate = bestWindow!.start; }}>
                <span class="best-icon"><Sparkles size={22} /></span>
                <span><small>BEST SHARED WINDOW</small><strong>{format(bestWindow.start, "MMM d")} - {format(bestWindow.end, "MMM d")}</strong></span>
                <span class="best-days"><b>{bestWindow.days}</b><small>days together</small></span>
                <span>Show on calendar <ArrowRight size={15} /></span>
              </button>
            {/if}

            <div class="month-nav">
              <button aria-label="Previous month" onclick={() => (activeMonth = subMonths(activeMonth, 1))}><ArrowLeft size={18} /></button>
              <div><span>MONTH VIEW</span><strong>{format(activeMonth, "MMMM yyyy")}</strong></div>
              <button aria-label="Next month" onclick={() => (activeMonth = addMonths(activeMonth, 1))}><ArrowRight size={18} /></button>
            </div>

            <div class="calendar-wrap">
              <div class="weekday-row">{#each weekdays as day}<span>{day}</span>{/each}</div>
              <div class="month-grid">
                {#each leadingDays as _}<div class="empty-day" aria-hidden="true"></div>{/each}
                {#each monthDays as date}
                  <button
                    class:everyone-off={everyoneIsOff(date)}
                    class:selected={format(date, "yyyy-MM-dd") === format(selectedDate, "yyyy-MM-dd")}
                    class="day-cell"
                    aria-label={format(date, "EEEE, MMMM d, yyyy")}
                    onclick={() => (selectedDate = date)}
                  >
                    <span class="day-number">{format(date, "d")}</span>
                    {#if everyoneIsOff(date)}<span class="everyone-label"><Check size={10} /> ALL FREE</span>{/if}
                    <span class="school-lines" aria-hidden="true">
                      {#each selectedSchools as school}
                        <i class:off={schoolIsOff(school.id, date)} style:--school-color={school.color}><b>{school.initials}</b><span></span></i>
                      {/each}
                    </span>
                  </button>
                {/each}
              </div>
            </div>

            <div class="date-detail">
              <div><span>SELECTED DATE</span><strong>{format(selectedDate, "EEEE, MMMM d")}</strong></div>
              <div class="detail-schools">
                {#each selectedSchools as school}
                  <span class:off={schoolIsOff(school.id, selectedDate)} style:--school-color={school.color}>
                    <i></i>{school.shortName}<b>{schoolIsOff(school.id, selectedDate) ? "No classes" : "Classes"}</b>
                  </span>
                {/each}
              </div>
            </div>
          {/if}
        </section>
      </div>
    {/if}
  </section>
</main>

{#if schoolPickerOpen}
  <AddSchoolModal
    schools={allSchools}
    {selectedIds}
    {academicYear}
    onclose={() => (schoolPickerOpen = false)}
    onadd={addSchool}
    oncreated={upsertSchool}
  />
{/if}

{#if reportOpen && reportSchool}
  <div class="modal-backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && closeReport()}>
    <div class="modal report-modal" role="dialog" aria-modal="true" aria-labelledby="report-title" tabindex="-1">
      <button class="modal-close" aria-label="Close" onclick={closeReport}><X size={18} /></button>
      <span class="modal-kicker">CALENDAR CORRECTION</span>
      <h2 id="report-title">Report a problem with {reportSchool.shortName}</h2>
      <p>Tell us which date is wrong or missing. A report proposes a correction and never overwrites the shared calendar automatically.</p>
      <textarea bind:value={reportDetails} rows="5" placeholder="Example: Spring break should end on March 21, not March 20."></textarea>
      <button class="primary-button" disabled={reportDetails.trim().length < 10 || reportSubmitting || reportSucceeded} onclick={submitReport}>
        {reportSubmitting ? "Submitting..." : reportSucceeded ? "Submitted" : "Submit report"}
      </button>
      {#if reportStatus}
        <div class:error={!reportSucceeded} class="report-status" role={reportSucceeded ? "status" : "alert"}>
          {#if reportSucceeded}<Check size={16} />{:else}<AlertTriangle size={16} />{/if}
          {reportStatus}
        </div>
      {/if}
    </div>
  </div>
{/if}

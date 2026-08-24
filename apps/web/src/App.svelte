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
  import { AlertTriangle, ArrowLeft, ArrowRight, CalendarDays, Check, Plus, Search, Sparkles, X } from "@lucide/svelte";
  import type { CalendarComparison, CalendarEvent, School } from "@commondays/shared";

  const academicYear = "2026-27";
  const weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

  let comparison: CalendarComparison | null = null;
  let allSchools: School[] = [];
  let selectedIds = ["uiuc", "berkeley", "nyu"];
  let activeMonth = new Date(2026, 11, 1);
  let selectedDate = new Date(2026, 11, 23);
  let isLoading = true;
  let error = "";
  let schoolPickerOpen = false;
  let reportOpen = false;
  let reportSchool: School | null = null;
  let reportDetails = "";
  let reportStatus = "";
  let query = "";

  $: selectedSchools = allSchools.filter((school) => selectedIds.includes(school.id));
  $: searchResults = allSchools.filter((school) => {
    if (selectedIds.includes(school.id)) return false;
    return `${school.name} ${school.shortName} ${school.location}`.toLowerCase().includes(query.toLowerCase());
  });
  $: monthStart = startOfMonth(activeMonth);
  $: monthDays = eachDayOfInterval({ start: monthStart, end: endOfMonth(activeMonth) });
  $: leadingDays = Array(monthStart.getDay()).fill(null);
  $: bestWindow = findBestWindow(comparison?.events ?? [], selectedIds);

  onMount(async () => {
    try {
      const schoolResponse = await fetch("/api/v1/schools");
      if (!schoolResponse.ok) throw new Error("School library unavailable");
      const schoolBody = (await schoolResponse.json()) as { schools: School[] };
      allSchools = schoolBody.schools;
      await loadComparison();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not load Common Days";
    } finally {
      isLoading = false;
    }
  });

  async function loadComparison() {
    const params = new URLSearchParams({ year: academicYear, schools: selectedIds.join(",") });
    const response = await fetch(`/api/v1/calendars?${params}`);
    if (!response.ok) throw new Error("Calendar comparison unavailable");
    comparison = (await response.json()) as CalendarComparison;
  }

  async function addSchool(id: string) {
    selectedIds = [...selectedIds, id];
    schoolPickerOpen = false;
    query = "";
    await loadComparison();
  }

  async function removeSchool(id: string) {
    if (selectedIds.length === 1) return;
    selectedIds = selectedIds.filter((schoolId) => schoolId !== id);
    await loadComparison();
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
    reportSchool = school;
    reportDetails = "";
    reportStatus = "";
    reportOpen = true;
  }

  async function submitReport() {
    if (!reportSchool || reportDetails.trim().length < 10) return;
    const response = await fetch("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schoolId: reportSchool.id,
        academicYear,
        reason: "other",
        details: reportDetails,
      }),
    });
    reportStatus = response.ok ? "Report submitted for review." : "That report could not be submitted.";
  }

  function findBestWindow(events: CalendarEvent[], schoolIds: string[]) {
    if (!events.length || !schoolIds.length) return null;
    const dates = eachDayOfInterval({ start: new Date(2026, 7, 1), end: new Date(2027, 8, 1) });
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
      <span>commondays.app/groups/summer-plans</span>
      <b>DEVELOPMENT DATA</b>
    </div>

    {#if isLoading}
      <div class="state-panel"><Sparkles class="spin" size={24} /> Loading the school library...</div>
    {:else if error}
      <div class="state-panel error"><AlertTriangle size={24} /> {error}. Make sure the API is running.</div>
    {:else}
      <div class="app-grid">
        <aside class="sidebar">
          <div class="group-heading">
            <div><span>YOUR GROUP</span><h2>Summer plans</h2></div>
            <button class="round-button" aria-label="Add a school" onclick={() => (schoolPickerOpen = true)}><Plus size={19} /></button>
          </div>

          <div class="friend-row" aria-label="Four friends in this group">
            <i>NV</i><i>MJ</i><i>SK</i><i>+</i><span>4 friends</span>
          </div>

          <div class="school-list">
            {#each selectedSchools as school (school.id)}
              <article class="school-card">
                <span class="school-avatar" style:background={school.color}>{school.initials}</span>
                <div><strong>{school.shortName}</strong><small>{academicYear} · Available</small></div>
                <div class="school-actions">
                  <button onclick={() => openReport(school)}>Report</button>
                  <button aria-label={`Remove ${school.shortName}`} onclick={() => removeSchool(school.id)}><X size={13} /></button>
                </div>
              </article>
            {/each}
          </div>

          <button class="add-school" onclick={() => (schoolPickerOpen = true)}><Plus size={17} /> Add another school</button>

          <div class="share-card">
            <span><Sparkles size={18} /></span>
            <strong>Bring your friends in</strong>
            <p>Everyone can use the same group comparison.</p>
            <button>Copy group link</button>
          </div>
        </aside>

        <section class="calendar-panel">
          <div class="calendar-title">
            <div><span>ACADEMIC YEAR {academicYear}</span><h2>When is everyone free?</h2></div>
            <button class="secondary-button"><CalendarDays size={16} /> Year overview</button>
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
        </section>
      </div>
    {/if}
  </section>
</main>

{#if schoolPickerOpen}
  <div class="modal-backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && (schoolPickerOpen = false)}>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="school-picker-title" tabindex="-1">
      <button class="modal-close" aria-label="Close" onclick={() => (schoolPickerOpen = false)}><X size={18} /></button>
      <span class="modal-kicker">ADD TO YOUR GROUP</span>
      <h2 id="school-picker-title">What school are we adding?</h2>
      <label class="search-box"><Search size={18} /><input bind:value={query} placeholder="Search a college or university" /></label>
      <div class="search-results">
        {#each searchResults as school}
          <button onclick={() => addSchool(school.id)}>
            <span class="school-avatar" style:background={school.color}>{school.initials}</span>
            <span><strong>{school.name}</strong><small>{school.location} · {academicYear} available</small></span>
            <Plus size={18} />
          </button>
        {:else}
          <p>No other matching schools yet. Uploading a missing calendar comes next.</p>
        {/each}
      </div>
    </div>
  </div>
{/if}

{#if reportOpen && reportSchool}
  <div class="modal-backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && (reportOpen = false)}>
    <div class="modal report-modal" role="dialog" aria-modal="true" aria-labelledby="report-title" tabindex="-1">
      <button class="modal-close" aria-label="Close" onclick={() => (reportOpen = false)}><X size={18} /></button>
      <span class="modal-kicker">CALENDAR CORRECTION</span>
      <h2 id="report-title">Report a problem with {reportSchool.shortName}</h2>
      <p>Tell us which date is wrong or missing. A report proposes a correction and never overwrites the shared calendar automatically.</p>
      <textarea bind:value={reportDetails} rows="5" placeholder="Example: Spring break should end on March 21, not March 20."></textarea>
      <button class="primary-button" disabled={reportDetails.trim().length < 10} onclick={submitReport}>Submit report</button>
      {#if reportStatus}<div class="report-status"><Check size={16} /> {reportStatus}</div>{/if}
    </div>
  </div>
{/if}

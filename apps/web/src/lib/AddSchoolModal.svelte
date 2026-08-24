<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import {
    ArrowLeft,
    Check,
    FileImage,
    FileText,
    LoaderCircle,
    Plus,
    Search,
    Sparkles,
    Upload,
    X,
  } from "@lucide/svelte";
  import type { CalendarAvailability, CalendarSubmission, School } from "@commondays/shared";
  import { CALENDAR_UPLOAD_MAX_SCREENSHOTS } from "@commondays/shared/upload-limits";
  import { addCalendarFiles, formatFileSize, type UploadMode } from "./calendar-upload.js";

  export let schools: School[];
  export let selectedIds: string[];
  export let academicYear: string;
  export let onclose: () => void;
  export let onadd: (schoolId: string) => Promise<void>;

  type Step = "school" | "checking" | "ready" | "upload" | "processing" | "waiting" | "success";

  let step: Step = "school";
  let query = "";
  let selectedSchool: School | null = null;
  let uploadMode: UploadMode | null = null;
  let files: File[] = [];
  let fileError = "";
  let isDragging = false;
  let processingStage = "Saving the official calendar source";
  let dialog: HTMLDivElement;
  let searchInput: HTMLInputElement;
  let fileInput: HTMLInputElement;
  let stepHeading: HTMLHeadingElement;
  let previousFocus: HTMLElement | null = null;
  let previousBodyOverflow = "";
  let pollToken = 0;
  let availabilityToken = 0;
  let isAdding = false;

  $: searchResults = schools.filter((school) => {
    if (selectedIds.includes(school.id)) return false;
    return `${school.name} ${school.shortName} ${school.location}`.toLowerCase().includes(query.toLowerCase());
  });

  onMount(async () => {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    await tick();
    searchInput?.focus();
  });

  onDestroy(() => {
    pollToken += 1;
    availabilityToken += 1;
    document.body.style.overflow = previousBodyOverflow;
    previousFocus?.focus();
  });

  function close() {
    pollToken += 1;
    availabilityToken += 1;
    onclose();
  }

  function goBack() {
    if (step === "school") return close();
    pollToken += 1;
    availabilityToken += 1;
    step = "school";
    selectedSchool = null;
    uploadMode = null;
    files = [];
    fileError = "";
    tick().then(() => searchInput?.focus());
  }

  async function focusCurrentStep() {
    await tick();
    (stepHeading ?? dialog)?.focus();
  }

  async function chooseSchool(school: School) {
    const requestToken = ++availabilityToken;
    selectedSchool = school;
    step = "checking";
    fileError = "";
    await focusCurrentStep();

    try {
      const response = await fetch(
        `/api/v1/schools/${encodeURIComponent(school.id)}/calendars/${encodeURIComponent(academicYear)}/availability`,
      );
      if (!response.ok) throw new Error("Could not check that calendar.");
      const availability = (await response.json()) as CalendarAvailability;
      if (requestToken !== availabilityToken) return;

      if (availability.status === "available") {
        step = "ready";
        await focusCurrentStep();
      } else if (availability.status === "processing" && availability.submissionId) {
        step = "processing";
        await focusCurrentStep();
        await pollSubmission(availability.submissionId);
      } else {
        step = "upload";
        await focusCurrentStep();
      }
    } catch (cause) {
      if (requestToken !== availabilityToken) return;
      fileError = cause instanceof Error ? cause.message : "Could not check that calendar.";
      step = "school";
      await tick();
      searchInput?.focus();
    }
  }

  async function addAvailableSchool() {
    if (!selectedSchool || isAdding) return;
    isAdding = true;
    fileError = "";
    try {
      await onadd(selectedSchool.id);
    } catch (cause) {
      step = "school";
      selectedSchool = null;
      fileError = cause instanceof Error ? cause.message : "That school could not be added.";
      await tick();
      searchInput?.focus();
    } finally {
      isAdding = false;
    }
  }

  async function pickFiles(mode: UploadMode) {
    if (uploadMode && uploadMode !== mode && files.length > 0) {
      fileError = "Remove the selected files before switching upload types.";
      return;
    }
    uploadMode = mode;
    fileError = "";
    await tick();
    if (fileInput) {
      fileInput.value = "";
      fileInput.click();
    }
  }

  function acceptFiles(incoming: File[]) {
    const result = addCalendarFiles(files, incoming);
    files = result.files;
    uploadMode = result.mode;
    fileError = result.error;
    if (fileInput) fileInput.value = "";
  }

  function handleFileInput(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    acceptFiles(Array.from(input.files ?? []));
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDragging = false;
    acceptFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  async function removeFile(index: number) {
    files = files.filter((_, fileIndex) => fileIndex !== index);
    if (files.length === 0) uploadMode = null;
    fileError = "";
    await tick();

    const removeButtons = dialog?.querySelectorAll<HTMLButtonElement>("[data-file-remove]") ?? [];
    if (removeButtons.length > 0) {
      removeButtons[Math.min(index, removeButtons.length - 1)]?.focus();
      return;
    }

    dialog?.querySelector<HTMLElement>(".drop-zone")?.focus();
  }

  async function submitCalendar() {
    if (!selectedSchool || files.length === 0) return;
    step = "processing";
    processingStage = "Saving the official calendar source";
    fileError = "";
    await focusCurrentStep();

    const form = new FormData();
    files.forEach((file) => form.append("files", file));

    try {
      const response = await fetch(
        `/api/v1/schools/${encodeURIComponent(selectedSchool.id)}/calendars/${encodeURIComponent(academicYear)}/submissions`,
        { method: "POST", body: form },
      );
      const body = (await response.json()) as {
        submission?: CalendarSubmission;
        submissionId?: string;
        code?: string;
        error?: string;
      };

      if (response.status === 409 && body.code === "CALENDAR_ALREADY_AVAILABLE") {
        step = "ready";
        await focusCurrentStep();
        return;
      }
      if (response.status === 409 && body.code === "SUBMISSION_ALREADY_IN_PROGRESS" && body.submissionId) {
        await pollSubmission(body.submissionId);
        return;
      }
      if (!response.ok || !body.submission) throw new Error(body.error ?? "That calendar could not be submitted.");

      await pollSubmission(body.submission.id);
    } catch (cause) {
      step = "upload";
      fileError = cause instanceof Error ? cause.message : "That calendar could not be submitted.";
      await focusCurrentStep();
    }
  }

  async function pollSubmission(submissionId: string) {
    const token = ++pollToken;
    let attempt = 0;

    while (token === pollToken) {
      processingStage = attempt === 0
        ? "Upload received. Checking its processing status"
        : "Upload saved. Waiting for calendar extraction";
      await new Promise((resolve) => setTimeout(resolve, Math.min(450 + attempt * 150, 1_800)));
      if (token !== pollToken) return;

      const response = await fetch(`/api/v1/calendar-submissions/${encodeURIComponent(submissionId)}`);
      const body = (await response.json()) as { submission?: CalendarSubmission; error?: string };
      if (!response.ok || !body.submission) throw new Error(body.error ?? "Calendar processing stopped.");

      if (body.submission.status === "ready") {
        step = "success";
        await focusCurrentStep();
        await new Promise((resolve) => setTimeout(resolve, 650));
        if (token === pollToken && selectedSchool) await addAvailableSchool();
        return;
      }
      if (body.submission.status === "failed") throw new Error("The calendar could not be read. Try clearer pages.");
      attempt += 1;
      if (attempt >= 12) {
        step = "waiting";
        await focusCurrentStep();
        return;
      }
    }
  }

  function handleDropZoneKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    pickFiles(uploadMode ?? "screenshots");
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab" || !dialog) return;

    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="modal-backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && close()}>
  <div
    bind:this={dialog}
    class:withBack={step !== "school" && step !== "processing" && step !== "success"}
    class="modal add-school-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="school-picker-title"
    tabindex="-1"
  >
    {#if step !== "school" && step !== "processing" && step !== "success"}
      <button class="modal-back" aria-label="Back to school search" onclick={goBack}><ArrowLeft size={18} /></button>
    {/if}
    <button class="modal-close" aria-label="Close" onclick={close}><X size={18} /></button>

    {#if step === "school"}
      <span class="modal-kicker">ADD TO YOUR COMPARISON</span>
      <h2 bind:this={stepHeading} id="school-picker-title" tabindex="-1">What school are we adding?</h2>
      <p class="picker-year-context">Checking the <strong>{academicYear}</strong> academic year for this comparison.</p>
      <label class="search-box">
        <Search size={18} />
        <span class="sr-only">Search schools</span>
        <input bind:this={searchInput} bind:value={query} placeholder="Search a college or university" />
      </label>
      <div class="search-results availability-results">
        {#each searchResults as school}
          <button onclick={() => chooseSchool(school)}>
            <span class="school-avatar" style:background={school.color}>{school.initials}</span>
            <span><strong>{school.name}</strong><small>{school.location}</small></span>
            <span class:ready={school.availableYears.includes(academicYear)} class:missing={!school.availableYears.includes(academicYear)} class="availability-pill">
              {school.availableYears.includes(academicYear) ? `READY FOR ${academicYear}` : `${academicYear} NEEDED`}
            </span>
          </button>
        {:else}
          <p>No other matching schools are in the library yet.</p>
        {/each}
      </div>
      {#if fileError}<p class="upload-error" role="alert">{fileError}</p>{/if}
    {:else if selectedSchool && step === "checking"}
      <div class="processing-card compact" role="status" aria-live="polite">
        <span class="processing-icon"><LoaderCircle class="spin" size={28} /></span>
        <span class="modal-kicker">CHECKING THE LIBRARY</span>
        <h2 bind:this={stepHeading} id="school-picker-title" tabindex="-1">Looking for {selectedSchool.shortName}</h2>
        <p>Checking the {academicYear} calendar collection.</p>
      </div>
    {:else if selectedSchool && step === "ready"}
      <span class="modal-kicker">CALENDAR FOUND</span>
      <h2 bind:this={stepHeading} id="school-picker-title" tabindex="-1">{selectedSchool.shortName} is ready to use.</h2>
      <div class="selected-school-summary">
        <span class="school-avatar" style:background={selectedSchool.color}>{selectedSchool.initials}</span>
        <span><strong>{selectedSchool.name}</strong><small>{selectedSchool.location}</small></span>
        <b>{academicYear}</b>
      </div>
      <div class="availability-card ready">
        <span><Check size={21} /></span>
        <div><strong>Already in the Common Days library</strong><p>Someone submitted this school year already, so nobody else needs to upload it again.</p></div>
      </div>
      {#if fileError}<p class="upload-error" role="alert">{fileError}</p>{/if}
      <button class="primary-button lime" disabled={isAdding} onclick={addAvailableSchool}><Plus size={17} /> {isAdding ? "Adding school..." : `Add ${selectedSchool.shortName}`}</button>
    {:else if selectedSchool && step === "upload"}
      <span class="modal-kicker">CALENDAR NEEDED</span>
      <h2 bind:this={stepHeading} id="school-picker-title" tabindex="-1">Be the first to add {selectedSchool.shortName}.</h2>
      <div class="selected-school-summary compact">
        <span class="school-avatar" style:background={selectedSchool.color}>{selectedSchool.initials}</span>
        <span><strong>{selectedSchool.name}</strong><small>Academic year {academicYear}</small></span>
      </div>
      <p class="upload-intro">Upload multiple screenshots of the official academic calendar or one official PDF. AI will read the important dates and save this school year for everyone.</p>

      <div class="upload-mode-grid">
        <button aria-pressed={uploadMode === "screenshots"} class:selected={uploadMode === "screenshots"} onclick={() => pickFiles("screenshots")}>
          <FileImage size={23} /><span><strong>Screenshots</strong><small>Add every page you need</small></span>
        </button>
        <button aria-pressed={uploadMode === "pdf"} class:selected={uploadMode === "pdf"} onclick={() => pickFiles("pdf")}>
          <FileText size={23} /><span><strong>Official PDF</strong><small>Upload the whole document</small></span>
        </button>
      </div>

      <input
        bind:this={fileInput}
        class="sr-only"
        type="file"
        tabindex="-1"
        accept={uploadMode === "pdf" ? "application/pdf" : uploadMode === "screenshots" ? "image/png,image/jpeg,image/webp" : "image/png,image/jpeg,image/webp,application/pdf"}
        multiple={uploadMode !== "pdf"}
        onchange={handleFileInput}
      />

      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {files.length === 0
          ? "No calendar files selected."
          : `${files.length} ${uploadMode === "pdf" ? "PDF" : files.length === 1 ? "screenshot" : "screenshots"} selected.`}
      </p>

      <div
        class:dragging={isDragging}
        class="drop-zone"
        role="button"
        tabindex="0"
        ondragover={(event) => { event.preventDefault(); isDragging = true; }}
        ondragleave={() => (isDragging = false)}
        ondrop={handleDrop}
        onkeydown={handleDropZoneKeydown}
      >
        <Upload size={25} />
        <strong>Drop calendar pages here</strong>
        <span>or choose screenshots or a PDF above</span>
      </div>

      {#if files.length > 0}
        <div class="selected-files-heading"><strong>{files.length} {uploadMode === "pdf" ? "PDF" : files.length === 1 ? "screenshot" : "screenshots"} selected</strong>{#if uploadMode === "screenshots" && files.length < CALENDAR_UPLOAD_MAX_SCREENSHOTS}<button onclick={() => pickFiles("screenshots")}><Plus size={14} /> Add more pages</button>{/if}</div>
        <div class="file-list">
          {#each files as file, index (`${file.name}-${file.size}-${file.lastModified}`)}
            <div class="file-row">
              <span class="file-icon">{#if file.type === "application/pdf"}<FileText size={18} />{:else}<FileImage size={18} />{/if}</span>
              <span><strong>{file.name}</strong><small>{formatFileSize(file.size)}</small></span>
              <button data-file-remove aria-label={`Remove ${file.name}`} onclick={() => removeFile(index)}><X size={16} /></button>
            </div>
          {/each}
        </div>
        {#if uploadMode === "screenshots" && files.length === CALENDAR_UPLOAD_MAX_SCREENSHOTS}
          <p class="upload-limit-note" role="status">You have added 10 screenshots. Remove one before adding a different page.</p>
        {/if}
      {/if}

      {#if fileError}<p class="upload-error" role="alert">{fileError}</p>{/if}
      <button class="primary-button" disabled={files.length === 0} onclick={submitCalendar}><Sparkles size={17} /> Submit calendar for processing</button>
    {:else if selectedSchool && step === "processing"}
      <div class="processing-card" role="status" aria-live="polite">
        <span class="processing-icon"><Sparkles size={27} /></span>
        <span class="modal-kicker">CALENDAR SUBMISSION</span>
        <h2 bind:this={stepHeading} id="school-picker-title" tabindex="-1">Preparing {selectedSchool.shortName}&apos;s calendar.</h2>
        <p>{processingStage}</p>
        <div class="progress-track" role="progressbar" aria-label="Calendar processing" aria-valuetext={processingStage}>
          <span></span>
        </div>
        <small>It will become reusable after extraction finishes.</small>
      </div>
    {:else if selectedSchool && step === "waiting"}
      <div class="processing-card waiting" role="status" aria-live="polite">
        <span class="processing-icon"><LoaderCircle size={28} /></span>
        <span class="modal-kicker">STILL PROCESSING</span>
        <h2 bind:this={stepHeading} id="school-picker-title" tabindex="-1">{selectedSchool.shortName}&apos;s upload is saved.</h2>
        <p>You can close this window and check again later. It is queued for calendar extraction.</p>
        <button class="primary-button lime" onclick={close}>Got it</button>
      </div>
    {:else if selectedSchool && step === "success"}
      <div class="processing-card success" role="status" aria-live="polite">
        <span class="processing-icon"><Check size={29} /></span>
        <span class="modal-kicker">SAVED FOR EVERYONE</span>
        <h2 bind:this={stepHeading} id="school-picker-title" tabindex="-1">{selectedSchool.shortName} {academicYear} is ready.</h2>
        <p>Adding it to your comparison now.</p>
      </div>
    {/if}
  </div>
</div>

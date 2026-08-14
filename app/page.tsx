"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type BreakEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  kind: "break" | "holiday" | "summer";
};

type School = {
  id: string;
  name: string;
  shortName: string;
  location: string;
  initials: string;
  color: string;
  available: boolean;
  breaks: BreakEvent[];
};

type ViewMode = "year" | "winter" | "spring";
type DisplayMode = "month" | "timeline";
type AddStage = "search" | "available" | "missing" | "extracting" | "review" | "published";

const DAY = 86_400_000;

const demoSchools: School[] = [
  {
    id: "uiuc",
    name: "University of Illinois Urbana-Champaign",
    shortName: "UIUC",
    location: "Urbana-Champaign, IL",
    initials: "IL",
    color: "#5968f2",
    available: true,
    breaks: [
      { id: "uiuc-fall", title: "Fall break", start: "2026-11-21", end: "2026-11-29", kind: "break" },
      { id: "uiuc-winter", title: "Winter break", start: "2026-12-19", end: "2027-01-17", kind: "break" },
      { id: "uiuc-spring", title: "Spring break", start: "2027-03-13", end: "2027-03-21", kind: "break" },
      { id: "uiuc-summer", title: "Summer", start: "2027-05-14", end: "2027-07-31", kind: "summer" },
    ],
  },
  {
    id: "berkeley",
    name: "University of California, Berkeley",
    shortName: "UC Berkeley",
    location: "Berkeley, CA",
    initials: "CA",
    color: "#ff735f",
    available: true,
    breaks: [
      { id: "cal-fall", title: "Thanksgiving", start: "2026-11-25", end: "2026-11-29", kind: "holiday" },
      { id: "cal-winter", title: "Winter break", start: "2026-12-12", end: "2027-01-18", kind: "break" },
      { id: "cal-spring", title: "Spring break", start: "2027-03-20", end: "2027-03-28", kind: "break" },
      { id: "cal-summer", title: "Summer", start: "2027-05-15", end: "2027-07-31", kind: "summer" },
    ],
  },
  {
    id: "nyu",
    name: "New York University",
    shortName: "NYU",
    location: "New York, NY",
    initials: "NY",
    color: "#1fae9e",
    available: true,
    breaks: [
      { id: "nyu-fall", title: "Thanksgiving", start: "2026-11-25", end: "2026-11-29", kind: "holiday" },
      { id: "nyu-winter", title: "Winter break", start: "2026-12-22", end: "2027-01-24", kind: "break" },
      { id: "nyu-spring", title: "Spring break", start: "2027-03-13", end: "2027-03-21", kind: "break" },
      { id: "nyu-summer", title: "Summer", start: "2027-05-12", end: "2027-07-31", kind: "summer" },
    ],
  },
  {
    id: "gatech",
    name: "Georgia Institute of Technology",
    shortName: "Georgia Tech",
    location: "Atlanta, GA",
    initials: "GT",
    color: "#e8a22b",
    available: true,
    breaks: [
      { id: "gt-fall", title: "Thanksgiving", start: "2026-11-25", end: "2026-11-29", kind: "holiday" },
      { id: "gt-winter", title: "Winter break", start: "2026-12-12", end: "2027-01-10", kind: "break" },
      { id: "gt-spring", title: "Spring break", start: "2027-03-20", end: "2027-03-28", kind: "break" },
      { id: "gt-summer", title: "Summer", start: "2027-05-08", end: "2027-07-31", kind: "summer" },
    ],
  },
  {
    id: "rice",
    name: "Rice University",
    shortName: "Rice",
    location: "Houston, TX",
    initials: "RU",
    color: "#9a62df",
    available: false,
    breaks: [],
  },
  {
    id: "northeastern",
    name: "Northeastern University",
    shortName: "Northeastern",
    location: "Boston, MA",
    initials: "NE",
    color: "#e35770",
    available: false,
    breaks: [],
  },
];

const riceDraft: BreakEvent[] = [
  { id: "rice-fall", title: "Thanksgiving recess", start: "2026-11-25", end: "2026-11-29", kind: "holiday" },
  { id: "rice-winter", title: "Winter recess", start: "2026-12-17", end: "2027-01-10", kind: "break" },
  { id: "rice-spring", title: "Spring recess", start: "2027-03-13", end: "2027-03-21", kind: "break" },
  { id: "rice-summer", title: "Summer", start: "2027-05-01", end: "2027-07-31", kind: "summer" },
];

const views: Record<ViewMode, { start: string; end: string; months: string[] }> = {
  year: {
    start: "2026-08-01",
    end: "2027-07-31",
    months: ["Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"],
  },
  winter: {
    start: "2026-11-01",
    end: "2027-02-28",
    months: ["Nov", "Dec", "Jan", "Feb"],
  },
  spring: {
    start: "2027-02-01",
    end: "2027-05-31",
    months: ["Feb", "Mar", "Apr", "May"],
  },
};

const academicMonths = [
  { year: 2026, month: 7, label: "August 2026" },
  { year: 2026, month: 8, label: "September 2026" },
  { year: 2026, month: 9, label: "October 2026" },
  { year: 2026, month: 10, label: "November 2026" },
  { year: 2026, month: 11, label: "December 2026" },
  { year: 2027, month: 0, label: "January 2027" },
  { year: 2027, month: 1, label: "February 2027" },
  { year: 2027, month: 2, label: "March 2027" },
  { year: 2027, month: 3, label: "April 2027" },
  { year: 2027, month: 4, label: "May 2027" },
  { year: 2027, month: 5, label: "June 2027" },
  { year: 2027, month: 6, label: "July 2027" },
];

const weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function utc(iso: string) {
  return Date.parse(`${iso}T00:00:00Z`);
}

function formatDay(iso: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(utc(iso)));
}

function formatFullDay(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(utc(iso)));
}

function toIsoDate(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

function buildMonthCells(year: number, month: number) {
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const dayCount = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: dayCount }, (_, index) => toIsoDate(year, month, index + 1)),
  ];
  const trailingCells = (7 - (cells.length % 7)) % 7;
  return [...cells, ...Array.from({ length: trailingCells }, () => null)];
}

function eventOnDate(school: School, iso: string) {
  const day = utc(iso);
  return school.breaks.find((event) => day >= utc(event.start) && day <= utc(event.end));
}

function daysBetween(start: string, end: string) {
  return Math.round((utc(end) - utc(start)) / DAY) + 1;
}

function getCommonBreaks(schools: School[], start: string, end: string): BreakEvent[] {
  if (schools.length < 2) return [];
  const startMs = utc(start);
  const endMs = utc(end);
  const commonDays: number[] = [];

  for (let day = startMs; day <= endMs; day += DAY) {
    const everyoneFree = schools.every((school) =>
      school.breaks.some((event) => day >= utc(event.start) && day <= utc(event.end)),
    );
    if (everyoneFree) commonDays.push(day);
  }

  const segments: BreakEvent[] = [];
  let segmentStart: number | null = null;
  let previous: number | null = null;

  commonDays.forEach((day, index) => {
    if (segmentStart === null) segmentStart = day;
    if (previous !== null && day - previous > DAY) {
      segments.push({
        id: `common-${segmentStart}`,
        title: "Everyone is free",
        start: new Date(segmentStart).toISOString().slice(0, 10),
        end: new Date(previous).toISOString().slice(0, 10),
        kind: "break",
      });
      segmentStart = day;
    }
    previous = day;
    if (index === commonDays.length - 1 && segmentStart !== null) {
      segments.push({
        id: `common-${segmentStart}`,
        title: "Everyone is free",
        start: new Date(segmentStart).toISOString().slice(0, 10),
        end: new Date(day).toISOString().slice(0, 10),
        kind: "break",
      });
    }
  });

  return segments;
}

function barStyle(event: BreakEvent, view: (typeof views)[ViewMode]) {
  const rangeStart = utc(view.start);
  const rangeEnd = utc(view.end) + DAY;
  const eventStart = Math.max(utc(event.start), rangeStart);
  const eventEnd = Math.min(utc(event.end) + DAY, rangeEnd);
  if (eventStart >= rangeEnd || eventEnd <= rangeStart) return null;
  return {
    left: `${((eventStart - rangeStart) / (rangeEnd - rangeStart)) * 100}%`,
    width: `${Math.max(((eventEnd - eventStart) / (rangeEnd - rangeStart)) * 100, 0.8)}%`,
  };
}

function TimelineBar({ event, view, common = false }: { event: BreakEvent; view: (typeof views)[ViewMode]; common?: boolean }) {
  const style = barStyle(event, view);
  if (!style) return null;
  const wideEnough = parseFloat(style.width) > 10;
  return (
    <div
      className={`timeline-bar ${common ? "common-bar" : ""} ${event.kind === "summer" ? "summer-bar" : ""}`}
      style={style}
      title={`${event.title}: ${formatDay(event.start)}–${formatDay(event.end)}`}
    >
      {wideEnough ? <span>{common ? `${daysBetween(event.start, event.end)} days` : event.title}</span> : null}
    </div>
  );
}

function MonthDay({
  iso,
  schools,
  selected,
  onSelect,
}: {
  iso: string;
  schools: School[];
  selected: boolean;
  onSelect: (date: string) => void;
}) {
  const events = schools.map((school) => eventOnDate(school, iso));
  const freeCount = events.filter(Boolean).length;
  const everyoneFree = schools.length >= 2 && freeCount === schools.length;
  const dayNumber = Number(iso.slice(-2));
  const weekday = new Date(utc(iso)).getUTCDay();
  const spokenStatuses = schools
    .map((school, index) => `${school.shortName} ${events[index] ? "has no classes" : "has no reported break"}`)
    .join(", ");

  return (
    <button
      className={`month-day ${everyoneFree ? "all-free-day" : ""} ${selected ? "selected-day" : ""} ${weekday === 0 || weekday === 6 ? "weekend-day" : ""}`}
      onClick={() => onSelect(iso)}
      aria-label={`${formatFullDay(iso)}. ${spokenStatuses}.${everyoneFree ? " Everyone overlaps." : ""}`}
    >
      <span className="day-number">{dayNumber}</span>
      {everyoneFree ? <span className="all-free-stamp">✦ ALL OFF</span> : freeCount > 0 ? <span className="partial-stamp">{freeCount}/{schools.length} OFF</span> : null}
      <span className="day-school-lines" aria-hidden="true">
        {schools.slice(0, 4).map((school, index) => (
          <span className={`day-school-line ${events[index] ? "is-free" : "is-busy"}`} key={school.id}>
            <b>{school.initials}</b>
            <i style={events[index] ? { background: school.color } : undefined} />
          </span>
        ))}
        {schools.length > 4 ? <span className="more-school-lines">+{schools.length - 4} more</span> : null}
      </span>
    </button>
  );
}

function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

export default function Home() {
  const [schools, setSchools] = useState(demoSchools);
  const [selectedIds, setSelectedIds] = useState(["uiuc", "berkeley", "nyu"]);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("month");
  const [viewMode, setViewMode] = useState<ViewMode>("year");
  const [monthIndex, setMonthIndex] = useState(4);
  const [selectedDate, setSelectedDate] = useState("2026-12-22");
  const [addOpen, setAddOpen] = useState(false);
  const [stage, setStage] = useState<AddStage>("search");
  const [query, setQuery] = useState("");
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [draftEvents, setDraftEvents] = useState(riceDraft);
  const [copied, setCopied] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedSchools = useMemo(
    () => selectedIds.map((id) => schools.find((school) => school.id === id)).filter(Boolean) as School[],
    [schools, selectedIds],
  );
  const view = views[viewMode];
  const currentMonth = academicMonths[monthIndex];
  const monthCells = useMemo(
    () => buildMonthCells(currentMonth.year, currentMonth.month),
    [currentMonth.year, currentMonth.month],
  );
  const commonBreaks = useMemo(
    () => getCommonBreaks(selectedSchools, view.start, view.end),
    [selectedSchools, view.start, view.end],
  );
  const allCommonBreaks = useMemo(
    () => getCommonBreaks(selectedSchools, views.year.start, views.year.end),
    [selectedSchools],
  );
  const bestBreak = useMemo(
    () => [...allCommonBreaks].sort((a, b) => daysBetween(b.start, b.end) - daysBetween(a.start, a.end))[0],
    [allCommonBreaks],
  );
  const selectedDayEvents = selectedSchools.map((school) => ({ school, event: eventOnDate(school, selectedDate) }));
  const selectedDayFreeCount = selectedDayEvents.filter((status) => status.event).length;
  const selectedDayEveryoneFree = selectedSchools.length >= 2 && selectedDayFreeCount === selectedSchools.length;
  const candidate = schools.find((school) => school.id === candidateId) ?? null;
  const searchResults = schools.filter((school) => {
    const haystack = `${school.name} ${school.shortName} ${school.location}`.toLowerCase();
    return haystack.includes(query.toLowerCase()) && !selectedIds.includes(school.id);
  });

  useEffect(() => {
    if (addOpen && stage === "search") window.setTimeout(() => searchRef.current?.focus(), 80);
  }, [addOpen, stage]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  function openAdd() {
    setQuery("");
    setCandidateId(null);
    setStage("search");
    setAddOpen(true);
  }

  function closeModal() {
    setAddOpen(false);
    setStage("search");
    setCandidateId(null);
  }

  function chooseSchool(school: School) {
    setCandidateId(school.id);
    setStage(school.available ? "available" : "missing");
  }

  function addAvailableSchool() {
    if (!candidate) return;
    setSelectedIds((ids) => (ids.includes(candidate.id) ? ids : [...ids, candidate.id]));
    closeModal();
  }

  function simulateUpload() {
    setStage("extracting");
    window.setTimeout(() => setStage("review"), 1100);
  }

  function updateDraft(id: string, field: "title" | "start" | "end", value: string) {
    setDraftEvents((events) => events.map((event) => (event.id === id ? { ...event, [field]: value } : event)));
  }

  function publishDraft() {
    if (!candidate) return;
    setSchools((current) =>
      current.map((school) => (school.id === candidate.id ? { ...school, available: true, breaks: draftEvents } : school)),
    );
    setSelectedIds((ids) => (ids.includes(candidate.id) ? ids : [...ids, candidate.id]));
    setStage("published");
  }

  function removeSchool(id: string) {
    setSelectedIds((ids) => ids.filter((schoolId) => schoolId !== id));
  }

  function copyLink() {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function changeMonth(nextIndex: number) {
    const clamped = Math.max(0, Math.min(academicMonths.length - 1, nextIndex));
    const nextMonth = academicMonths[clamped];
    setMonthIndex(clamped);
    setSelectedDate(toIsoDate(nextMonth.year, nextMonth.month, 1));
  }

  function showBestBreak() {
    if (!bestBreak) return;
    const bestDate = new Date(utc(bestBreak.start));
    const matchingMonth = academicMonths.findIndex(
      (month) => month.year === bestDate.getUTCFullYear() && month.month === bestDate.getUTCMonth(),
    );
    if (matchingMonth >= 0) setMonthIndex(matchingMonth);
    setSelectedDate(bestBreak.start);
    setDisplayMode("month");
  }

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Common Days home">
          <Mark />
          <span>COMMON DAYS</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#planner">Demo</a>
          <a href="#how-it-works">How it works</a>
        </nav>
        <button className="header-button" onClick={openAdd}>Add a school <span>＋</span></button>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span>●</span> Proof of concept · sample dates</div>
          <h1>Find the break<br />everyone <em>actually</em> shares.</h1>
          <p>
            Pick your friends&apos; schools. We&apos;ll stack their academic calendars and show the days that line up—without making the next UIUC student upload the same calendar again.
          </p>
          <div className="hero-actions">
            <button className="primary-button" onClick={() => document.getElementById("planner")?.scrollIntoView({ behavior: "smooth" })}>
              Explore the demo <span>↓</span>
            </button>
            <button className="text-button" onClick={() => { openAdd(); setQuery("Rice"); }}>
              Try a missing school <span>↗</span>
            </button>
          </div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="mini-calendar">
            <div className="mini-top"><span>DEC 2026</span><b>3 schools</b></div>
            <div className="mini-dates"><span>18</span><span>19</span><span>20</span><span>21</span><strong>22</strong><strong>23</strong><strong>24</strong><span>25</span></div>
            <div className="mini-row"><i style={{ background: "#5968f2", width: "88%" }} /></div>
            <div className="mini-row"><i style={{ background: "#ff735f", width: "79%", marginLeft: "9%" }} /></div>
            <div className="mini-row"><i style={{ background: "#1fae9e", width: "70%", marginLeft: "18%" }} /></div>
            <div className="mini-highlight"><span>ALL FREE</span><b>27 DAYS</b></div>
          </div>
          <div className="hero-note note-one"><span>✓</span> UIUC calendar already here</div>
          <div className="hero-note note-two"><span>3</span> calendars compared</div>
        </div>
      </section>

      <section className="planner-section" id="planner">
        <div className="section-heading">
          <div>
            <span className="section-number">01</span>
            <p>LIVE PROTOTYPE</p>
          </div>
          <h2>Your group&apos;s calendar,<br />finally in one place.</h2>
          <p className="section-note">Click around. Remove a school, add Georgia Tech, or try Rice to see the missing-calendar flow.</p>
        </div>

        <div className="app-window">
          <div className="app-toolbar">
            <div className="window-dots"><i /><i /><i /></div>
            <div className="demo-address"><span>⌕</span> commondays.app/group/summer-plans</div>
            <div className="sample-pill">SAMPLE DATA</div>
          </div>

          <div className="app-body">
            <aside className="school-panel">
              <div className="panel-heading">
                <div>
                  <span className="tiny-label">YOUR GROUP</span>
                  <h3>Summer plans</h3>
                </div>
                <button className="icon-button" onClick={openAdd} aria-label="Add another school">＋</button>
              </div>

              <div className="people-row" aria-label="Four group members">
                <span className="person person-a">NV</span>
                <span className="person person-b">MJ</span>
                <span className="person person-c">SK</span>
                <span className="person person-d">＋</span>
                <small>4 friends</small>
              </div>

              <div className="school-list">
                {selectedSchools.map((school) => (
                  <div className="school-card" key={school.id}>
                    <span className="school-avatar" style={{ background: school.color }}>{school.initials}</span>
                    <span className="school-copy"><strong>{school.shortName}</strong><small>2026–27 · Available</small></span>
                    <button onClick={() => removeSchool(school.id)} aria-label={`Remove ${school.shortName}`}>×</button>
                  </div>
                ))}
              </div>

              <button className="add-school-button" onClick={openAdd}><span>＋</span> Add another school</button>

              <div className="share-card">
                <span className="share-spark">✦</span>
                <strong>Bring your friends in</strong>
                <p>They can see this comparison without uploading anything.</p>
                <button onClick={copyLink}>{copied ? "Copied!" : "Copy group link"}</button>
              </div>
            </aside>

            <div className="calendar-panel">
              <div className="calendar-header">
                <div>
                  <span className="tiny-label">ACADEMIC YEAR 2026–27</span>
                  <h3>When is everyone free?</h3>
                </div>
                <div className="display-switcher" aria-label="Calendar display">
                  <button
                    className={displayMode === "month" ? "active" : ""}
                    aria-pressed={displayMode === "month"}
                    onClick={() => setDisplayMode("month")}
                  >
                    Month calendar
                  </button>
                  <button
                    className={displayMode === "timeline" ? "active" : ""}
                    aria-pressed={displayMode === "timeline"}
                    onClick={() => setDisplayMode("timeline")}
                  >
                    Year overview
                  </button>
                </div>
              </div>

              {bestBreak ? (
                <div className="best-window">
                  <div className="best-icon"><span>✦</span></div>
                  <div>
                    <span>BEST SHARED WINDOW</span>
                    <strong>{formatDay(bestBreak.start)} – {formatDay(bestBreak.end)}</strong>
                  </div>
                  <div className="best-count"><b>{daysBetween(bestBreak.start, bestBreak.end)}</b><span>days together</span></div>
                  <button onClick={showBestBreak}>Show on calendar →</button>
                </div>
              ) : (
                <div className="best-window empty-window"><div><span>NO SHARED WINDOW YET</span><strong>Try removing one school</strong></div></div>
              )}

              {displayMode === "month" ? (
                <div className="month-calendar-view">
                  <div className="month-navigation">
                    <button
                      onClick={() => changeMonth(monthIndex - 1)}
                      disabled={monthIndex === 0}
                      aria-label="Previous month"
                    >
                      ←
                    </button>
                    <div aria-live="polite">
                      <span>MONTH VIEW</span>
                      <strong>{currentMonth.label}</strong>
                    </div>
                    <button
                      onClick={() => changeMonth(monthIndex + 1)}
                      disabled={monthIndex === academicMonths.length - 1}
                      aria-label="Next month"
                    >
                      →
                    </button>
                  </div>

                  <div className="month-calendar-scroll">
                    <div className="normal-calendar">
                      <div className="weekday-row">
                        {weekdays.map((day) => <span key={day}>{day}</span>)}
                      </div>
                      <div className="month-grid">
                        {monthCells.map((iso, index) => (
                          iso ? (
                            <MonthDay
                              key={iso}
                              iso={iso}
                              schools={selectedSchools}
                              selected={selectedDate === iso}
                              onSelect={setSelectedDate}
                            />
                          ) : (
                            <div className="empty-day" aria-hidden="true" key={`empty-${index}`} />
                          )
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className={`day-detail-card ${selectedDayEveryoneFree ? "everyone-detail" : ""}`}>
                    <div className="day-detail-heading">
                      <div>
                        <span>SELECTED DAY</span>
                        <strong>{formatFullDay(selectedDate)}</strong>
                      </div>
                      <b>
                        {selectedDayEveryoneFree
                          ? "✦ EVERYONE IS OFF"
                          : `${selectedDayFreeCount} OF ${selectedSchools.length} OFF`}
                      </b>
                    </div>
                    <div className="day-detail-list">
                      {selectedDayEvents.map(({ school, event }) => (
                        <div className="day-detail-row" key={school.id}>
                          <span style={{ background: school.color }}>{school.initials}</span>
                          <strong>{school.shortName}</strong>
                          <i className={event ? "status-off" : "status-unknown"}>
                            {event ? event.title : "No school-wide break reported"}
                          </i>
                          <b>{event ? "NO CLASSES" : "—"}</b>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="timeline-controls">
                    <span>YEAR OVERVIEW</span>
                    <div className="view-switcher" aria-label="Calendar range">
                      {(["year", "winter", "spring"] as ViewMode[]).map((mode) => (
                        <button key={mode} className={viewMode === mode ? "active" : ""} onClick={() => setViewMode(mode)}>
                          {mode === "year" ? "Full year" : mode[0].toUpperCase() + mode.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="timeline-shell">
                    <div className="timeline-labels timeline-months-label"><span>School</span></div>
                    <div className="timeline-months" style={{ gridTemplateColumns: `repeat(${view.months.length}, minmax(76px, 1fr))` }}>
                      {view.months.map((month) => <span key={month}>{month}</span>)}
                    </div>

                    <div className="timeline-scroll">
                      <div className="timeline-grid" style={{ minWidth: `${view.months.length * 76}px` }}>
                        <div className="month-lines" style={{ gridTemplateColumns: `repeat(${view.months.length}, 1fr)` }}>
                          {view.months.map((month) => <i key={month} />)}
                        </div>

                        <div className="timeline-row common-row">
                          <div className="timeline-name"><span className="all-dot">✦</span><strong>Everyone</strong></div>
                          <div className="timeline-track">
                            {commonBreaks.map((event) => <TimelineBar key={event.id} event={event} view={view} common />)}
                          </div>
                        </div>

                        {selectedSchools.map((school) => (
                          <div className="timeline-row" key={school.id}>
                            <div className="timeline-name"><span style={{ background: school.color }}>{school.initials}</span><strong>{school.shortName}</strong></div>
                            <div className="timeline-track" style={{ "--school-color": school.color } as React.CSSProperties}>
                              {school.breaks.map((event) => <TimelineBar key={event.id} event={event} view={view} />)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              )}

              <div className="calendar-legend">
                <span><i className="legend-common" /> Everyone is free</span>
                <span><i className="legend-break" /> Colored line = reported break</span>
                <span><i className="legend-unknown" /> Dashed line = no break reported</span>
                <span className="demo-warning">Demo dates—not official school data</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="how-section" id="how-it-works">
        <div className="how-heading">
          <span className="section-number">02</span>
          <h2>Upload once.<br />Useful for everyone.</h2>
        </div>
        <div className="how-grid">
          <article>
            <span className="step-badge">1</span>
            <div className="step-visual search-visual"><span>⌕</span><p>UIUC</p><b>AVAILABLE</b></div>
            <h3>Check before uploading</h3>
            <p>Choose a school, calendar type, and year. If it already exists, use it instantly.</p>
          </article>
          <article>
            <span className="step-badge">2</span>
            <div className="step-visual upload-visual"><span>↑</span><p>academic-calendar.pdf</p><b>4 BREAKS FOUND</b></div>
            <h3>Fill the gap once</h3>
            <p>If it&apos;s missing, one person uploads and confirms the extracted dates.</p>
          </article>
          <article>
            <span className="step-badge">3</span>
            <div className="step-visual reuse-visual"><span>✓</span><p>Published for 2026–27</p><b>READY TO REUSE</b></div>
            <h3>Share the canonical version</h3>
            <p>Future students attach the reviewed calendar instead of creating another copy.</p>
          </article>
        </div>
      </section>

      <footer>
        <a className="brand footer-brand" href="#top"><Mark /><span>COMMON DAYS</span></a>
        <p>A proof of concept for finding time together.</p>
        <button onClick={() => document.getElementById("planner")?.scrollIntoView({ behavior: "smooth" })}>Back to demo ↑</button>
      </footer>

      {addOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <div className="modal-top">
              <div className="modal-progress" aria-label="Add school progress">
                <i className={stage !== "search" ? "done" : "active"}>1</i><span />
                <i className={["review", "published"].includes(stage) ? "done" : ["missing", "extracting"].includes(stage) ? "active" : ""}>2</i><span />
                <i className={stage === "published" ? "done" : stage === "review" ? "active" : ""}>3</i>
              </div>
              <button className="modal-close" onClick={closeModal} aria-label="Close dialog">×</button>
            </div>

            {stage === "search" ? (
              <div className="modal-content search-stage">
                <span className="modal-kicker">STEP 1 OF 3</span>
                <h2 id="modal-title">What school are we adding?</h2>
                <p>We&apos;ll check the shared library before asking for any upload.</p>
                <label className="search-box">
                  <span>⌕</span>
                  <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Try “Rice” or “Georgia Tech”" />
                </label>
                <div className="search-results" role="listbox" aria-label="School results">
                  {searchResults.slice(0, 5).map((school) => (
                    <button key={school.id} onClick={() => chooseSchool(school)} role="option" aria-selected="false">
                      <span className="school-avatar" style={{ background: school.color }}>{school.initials}</span>
                      <span><strong>{school.name}</strong><small>{school.location}</small></span>
                      <b className={school.available ? "available-status" : "missing-status"}>{school.available ? "AVAILABLE" : "MISSING"}</b>
                      <em>→</em>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {stage === "available" && candidate ? (
              <div className="modal-content result-stage">
                <div className="big-status available-big">✓</div>
                <span className="modal-kicker success-kicker">CALENDAR AVAILABLE</span>
                <h2 id="modal-title">Good news—someone already added {candidate.shortName}.</h2>
                <p>No upload needed. This reviewed community calendar is ready to attach.</p>
                <div className="calendar-result-card">
                  <span className="school-avatar large-avatar" style={{ background: candidate.color }}>{candidate.initials}</span>
                  <div><strong>{candidate.name}</strong><small>Undergraduate · 2026–2027</small></div>
                  <span className="event-count">{candidate.breaks.length} breaks</span>
                </div>
                <div className="source-line"><span>↗</span><div><b>Source on file</b><small>Sample registrar calendar · reviewed Jul 12</small></div></div>
                <button className="modal-primary" onClick={addAvailableSchool}>Use this calendar <span>→</span></button>
                <button className="modal-back" onClick={() => setStage("search")}>← Search another school</button>
              </div>
            ) : null}

            {stage === "missing" && candidate ? (
              <div className="modal-content result-stage">
                <div className="big-status missing-big">＋</div>
                <span className="modal-kicker missing-kicker">NOT IN THE LIBRARY YET</span>
                <h2 id="modal-title">Be the first to add {candidate.shortName}.</h2>
                <p>For this prototype, use our sample file. A real version would also accept PDFs, screenshots, spreadsheets, text, and .ics files.</p>
                <button className="drop-zone" onClick={simulateUpload}>
                  <span className="upload-arrow">↑</span>
                  <strong>Drop an academic calendar here</strong>
                  <small>or click to use a sample PDF</small>
                  <b>PDF · IMAGE · XLSX · TEXT · ICS</b>
                </button>
                <div className="privacy-note"><span>⌁</span><p><strong>School-wide calendars only</strong><br />Don&apos;t upload a personal class schedule.</p></div>
                <button className="modal-back" onClick={() => setStage("search")}>← Search another school</button>
              </div>
            ) : null}

            {stage === "extracting" ? (
              <div className="modal-content extracting-stage">
                <div className="scan-document">
                  <i className="scan-line" />
                  <span>ACADEMIC CALENDAR</span>
                  <b /><b /><b /><b />
                </div>
                <span className="modal-kicker">READING SAMPLE FILE</span>
                <h2 id="modal-title">Finding dates and breaks…</h2>
                <p>This is simulated in the prototype.</p>
                <div className="loading-track"><i /></div>
              </div>
            ) : null}

            {stage === "review" && candidate ? (
              <div className="modal-content review-stage">
                <span className="modal-kicker">STEP 3 OF 3</span>
                <h2 id="modal-title">Check what we found.</h2>
                <p>Nothing becomes shared until a person confirms it.</p>
                <div className="review-summary"><span>✓</span><strong>{draftEvents.length} no-class periods found</strong><small>From sample-academic-calendar.pdf</small></div>
                <div className="review-list">
                  {draftEvents.map((event) => (
                    <div className="review-row" key={event.id}>
                      <span className="confidence-dot" title="High confidence" />
                      <input aria-label="Event name" value={event.title} onChange={(e) => updateDraft(event.id, "title", e.target.value)} />
                      <label><small>START</small><input type="date" value={event.start} onChange={(e) => updateDraft(event.id, "start", e.target.value)} /></label>
                      <label><small>END</small><input type="date" value={event.end} onChange={(e) => updateDraft(event.id, "end", e.target.value)} /></label>
                    </div>
                  ))}
                </div>
                <label className="confirm-check"><input type="checkbox" defaultChecked /><span>I checked these dates against the source.</span></label>
                <button className="modal-primary" onClick={publishDraft}>Submit for review <span>→</span></button>
                <button className="modal-back" onClick={() => setStage("missing")}>← Back to upload</button>
              </div>
            ) : null}

            {stage === "published" && candidate ? (
              <div className="modal-content published-stage">
                <div className="celebration">✦</div>
                <span className="modal-kicker success-kicker">DEMO REVIEW PASSED</span>
                <h2 id="modal-title">{candidate.shortName} is now reusable.</h2>
                <p>This demo fast-forwards through review. The next student who picks this school and year will see “Calendar available”—no upload required.</p>
                <div className="published-card">
                  <span className="school-avatar large-avatar" style={{ background: candidate.color }}>{candidate.initials}</span>
                  <div><strong>{candidate.shortName} · 2026–27</strong><small>Community calendar · Version 1</small></div>
                  <span>✓</span>
                </div>
                <button className="modal-primary" onClick={closeModal}>See it in the comparison <span>→</span></button>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}

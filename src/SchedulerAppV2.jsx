import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

console.log("BEFORE RETURN");

// scheduler app v2 stabilized rewrite
const weekDays = ["월", "화", "수", "목", "금", "토", "일"];
const STORAGE_KEY = "scheduler_app_v2_state";
const DRIVE_META_KEY = "scheduler_app_v2_drive_meta";
const DRIVE_CONFIG_KEY = "scheduler_app_v2_drive_config";
const GOOGLE_API_DISCOVERY_DOC = "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest";
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_CALENDAR_DISCOVERY_DOC = "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest";
const GOOGLE_COMBINED_SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.events";
const REPEAT_OPTIONS = ["없음", "매일", "매주", "매월", "평일", "사용자지정"];
const LOCAL_BACKUP_KEY = "scheduler_app_v2_backup_history";
const MAX_LOCAL_BACKUPS = 20;
const DEFAULT_ALERT_OPTIONS = ["없음", "시작 시각", "5분 전", "10분 전", "30분 전", "1시간 전"];

const initialDateSchedules = {
  20: [
    {
      id: 1,
      title: "업무 미팅",
      time: "08:00 - 09:00",
      color: "#ef5da8",
      repeat: "없음",
      repeatDays: [],
      notes: `핸드레드 상세페이지 제작 관련 미팅\n제작 수량 4건 이상\n스타트는 샘플 입고 후\n촬영은 별도 진행 후 데이터만 전달`,
      checklist: [],
      alerts: [],
      checked: false,
      repeatGroupId: null,
      occurrenceIndex: 0,
      baseDay: 20,
    },
  ],
};

const initialWeekSchedules = {
  월: [],
  화: [],
  수: [],
  목: [],
  금: [],
  토: [],
  일: [],
};

const initialGoals = [
  { id: 201, title: "독서 노벨100선", notes: "노벨문학 100선", checked: false },
  { id: 202, title: "파이썬 학습", notes: "기초 문법", checked: false },
];

const initialTodos = [
  { id: 301, title: "핸드레드 미팅", notes: "상세페이지 작업", checked: false },
  { id: 302, title: "신제품 리서치", notes: "", checked: false },
];

function cls(...args) {
  return args.filter(Boolean).join(" ");
}

function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function loadSavedState() {
  if (typeof window === "undefined") return null;
  return safeJsonParse(window.localStorage.getItem(STORAGE_KEY), null);
}

function loadDriveMeta() {
  if (typeof window === "undefined") return null;
  return safeJsonParse(window.localStorage.getItem(DRIVE_META_KEY), null);
}

function saveDriveMeta(meta) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DRIVE_META_KEY, JSON.stringify(meta || {}));
}

function loadDriveConfig() {
  if (typeof window === "undefined") return null;
  return safeJsonParse(window.localStorage.getItem(DRIVE_CONFIG_KEY), null);
}

function saveDriveConfig(config) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DRIVE_CONFIG_KEY, JSON.stringify(config || {}));
}

function loadScriptOnce(src, globalName) {
  return new Promise((resolve, reject) => {
    if (typeof window !== "undefined" && globalName && window[globalName]) {
      resolve(window[globalName]);
      return;
    }
    if (typeof document === "undefined") {
      reject(new Error("document unavailable"));
      return;
    }
    const existing = document.querySelector(`script[data-src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(globalName ? window[globalName] : true), { once: true });
      existing.addEventListener("error", () => reject(new Error(`failed to load ${src}`)), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;
    script.dataset.src = src;
    script.onload = () => resolve(globalName ? window[globalName] : true);
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function loadGoogleClients() {
  await loadScriptOnce("https://apis.google.com/js/api.js", "gapi");
  await loadScriptOnce("https://accounts.google.com/gsi/client", "google");
  return { gapi: window.gapi, google: window.google };
}

async function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("file read failed"));
    reader.readAsText(file);
  });
}

async function createDriveMultipartBody(metadata, data) {
  const boundary = `scheduler_boundary_${Date.now()}`;
  const delimiter = ["", `--${boundary}`, ""].join("\r\n");
  const closeDelim = ["", `--${boundary}--`].join("\r\n");
  const body = [
    delimiter,
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(metadata),
    delimiter,
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(data),
    closeDelim,
  ].join("");
  return { boundary, body };
}

function nowIso() {
  return new Date().toISOString();
}

function buildPersistedPayload(state) {
  return {
    version: 1,
    updatedAt: nowIso(),
    deviceId: "web-local",
    data: state,
  };
}

function unwrapPersistedPayload(parsed) {
  if (!parsed) return null;
  if (parsed.data && typeof parsed.data === "object") return parsed.data;
  return parsed;
}

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function getStartOffset(year, month) {
  const day = new Date(year, month, 1).getDay();
  return day === 0 ? 6 : day - 1;
}

function getMonthGrid(year, month) {
  const days = getDaysInMonth(year, month);
  const startOffset = getStartOffset(year, month);
  const prevDays = getDaysInMonth(year, month - 1);
  const cells = [];
  for (let i = 0; i < startOffset; i += 1) cells.push({ day: prevDays - startOffset + i + 1, type: "prev" });
  for (let d = 1; d <= days; d += 1) cells.push({ day: d, type: "current" });
  let nextDay = 1;
  while (cells.length < 42) {
    cells.push({ day: nextDay, type: "next" });
    nextDay += 1;
  }
  return cells;
}

function getWeekOfYear(date) {
  const target = new Date(date.valueOf());
  const dayNr = (date.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstDayNr = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNr + 3);
  return 1 + Math.round((target - firstThursday) / 604800000);
}

function digitsOnly(value) {
  return Array.from(String(value || "")).filter((ch) => ch >= "0" && ch <= "9").join("");
}

function normalizeTimeInput(value) {
  const digits = digitsOnly(value).slice(0, 8);
  if (digits.length <= 4) return digits;
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}`;
}

function formatCompactTime(value) {
  const digits = digitsOnly(value);
  if (digits.length !== 8) return value;
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)} - ${digits.slice(4, 6)}:${digits.slice(6, 8)}`;
}

function displayCompactTime(value) {
  const digits = digitsOnly(value).slice(0, 8);
  if (digits.length <= 4) return digits;
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}`;
}

function parseTimeRange(timeText) {
  if (!timeText || !timeText.includes("-")) return null;
  const parts = timeText.split("-");
  if (parts.length !== 2) return null;
  const left = parts[0].trim().split(":");
  const right = parts[1].trim().split(":");
  if (left.length !== 2 || right.length !== 2) return null;
  const [sh, sm, eh, em] = [Number(left[0]), Number(left[1]), Number(right[0]), Number(right[1])];
  if ([sh, sm, eh, em].some(Number.isNaN)) return null;
  return { start: sh + sm / 60, end: eh + em / 60 };
}

function buildArcPath(center, innerR, outerR, startHour, endHour) {
  const startAngle = (startHour / 24) * Math.PI * 2 - Math.PI / 2;
  const endAngle = (endHour / 24) * Math.PI * 2 - Math.PI / 2;
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const x1 = center + outerR * Math.cos(startAngle);
  const y1 = center + outerR * Math.sin(startAngle);
  const x2 = center + outerR * Math.cos(endAngle);
  const y2 = center + outerR * Math.sin(endAngle);
  const x3 = center + innerR * Math.cos(endAngle);
  const y3 = center + innerR * Math.sin(endAngle);
  const x4 = center + innerR * Math.cos(startAngle);
  const y4 = center + innerR * Math.sin(startAngle);
  return `M ${x1} ${y1} A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4} ${y4} Z`;
}

function hexToRgb(hex) {
  const normalized = String(hex || "#000000").replace("#", "").padEnd(6, "0").slice(0, 6);
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHex(r, g, b) {
  const clamp = (n) => Math.max(0, Math.min(255, Number(n) || 0));
  return `#${[clamp(r), clamp(g), clamp(b)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function uploadJsonFile(fileName, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  try {
    const shareFile = new File([blob], fileName, { type: "application/json" });
    const hasShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
    const hasFileShare = hasShare && typeof navigator.canShare === "function" && navigator.canShare({ files: [shareFile] });
    if (hasFileShare) {
      await navigator.share({ files: [shareFile], title: fileName });
      return true;
    }
  } catch {
    // ignore and fall back to local download
  }
  downloadJson(fileName, data);
  return false;
}

function getAddButtonLabel(title) {
  if (title === "목표") return "목표 추가";
  if (title === "TO-DO") return "TO-DO 추가";
  return "일정 추가";
}

function alertLabelToMinutes(label) {
  if (label === "시작 시각") return 0;
  if (label === "5분 전") return 5;
  if (label === "10분 전") return 10;
  if (label === "30분 전") return 30;
  if (label === "1시간 전") return 60;
  return null;
}

function parseTimeStartToDate(baseDate, timeText) {
  if (!baseDate || !timeText) return null;
  const parsed = parseTimeRange(timeText);
  if (!parsed) return null;
  const hours = Math.floor(parsed.start);
  const minutes = Math.round((parsed.start - hours) * 60);
  const dt = new Date(baseDate);
  dt.setHours(hours, minutes, 0, 0);
  return dt;
}

function loadBackupHistory() {
  if (typeof window === "undefined") return [];
  const parsed = safeJsonParse(window.localStorage.getItem(LOCAL_BACKUP_KEY), []);
  return Array.isArray(parsed) ? parsed : [];
}

function saveBackupHistory(items) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify(items || []));
}

function pushLocalBackupSnapshot(snapshot) {
  const history = loadBackupHistory();
  const safeHistory = Array.isArray(history) ? history : [];
  const next = [{ id: `backup-${Date.now()}`, createdAt: nowIso(), payload: snapshot }, ...safeHistory].slice(0, MAX_LOCAL_BACKUPS);
  saveBackupHistory(next);
  return next;
}

function getNotificationPermissionSafe() {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

function isRepeatScopePatch(patch) {
  return ["title", "time", "repeat", "repeatDays", "color"].some((key) => key in (patch || {}));
}

function splitChecklist(value) {
  if (!value) return [];
  return String(value)
    .split(/[|\n]/)
    .map((item, index) => ({ id: index + 1, label: item.trim(), checked: false }))
    .filter((item) => item.label);
}

function mapRepeatRule(daysValue) {
  if (daysValue === "daily") return "매일";
  if (daysValue === "weekdays") return "평일";
  if (daysValue === "weekly") return "매주";
  if (daysValue === "monthly") return "매월";
  return "없음";
}

function mapPriorityAlerts(priority) {
  if (priority === "high") return ["시작 시각", "5분 전"];
  if (priority === "medium") return ["시작 시각"];
  return [];
}

function dedupeAlerts(alerts) {
  return Array.from(new Set((alerts || []).filter(Boolean)));
}

function normalizeImportedTime(startTime, endTime, durationMin) {
  const safeStart = startTime || "00:00";
  let safeEnd = endTime || "";
  if (safeEnd === "24:00") safeEnd = "23:59";
  if (!safeEnd && durationMin) {
    const [sh, sm] = safeStart.split(":").map(Number);
    const baseMin = sh * 60 + sm;
    const nextMin = baseMin + Number(durationMin || 0);
    safeEnd = `${String(Math.floor(nextMin / 60) % 24).padStart(2, "0")}:${String(nextMin % 60).padStart(2, "0")}`;
  }
  return `${safeStart} - ${safeEnd || safeStart}`;
}

function buildImportedNotes(item) {
  const lines = [];
  if (item.notes) lines.push(item.notes);
  const checklistItems = splitChecklist(item.checklist);
  if (checklistItems.length) {
    lines.push("", "체크리스트");
    checklistItems.forEach((entry) => lines.push(`- [ ] ${entry.label}`));
  }
  const alerts = mapPriorityAlerts(item.priority);
  if (alerts.length) lines.push("", `알림: ${alerts.join(", ")}`);
  return lines.join("\n");
}

function ensureRepeatMeta(item, fallbackBaseDay = 1) {
  const repeatable = item.repeat && item.repeat !== "없음";
  return {
    ...item,
    repeatDays: Array.isArray(item.repeatDays) ? item.repeatDays : [],
    repeatGroupId: repeatable ? item.repeatGroupId || `repeat-${item.id}` : null,
    occurrenceIndex: Number.isFinite(item.occurrenceIndex) ? item.occurrenceIndex : 0,
    baseDay: Number.isFinite(item.baseDay) ? item.baseDay : fallbackBaseDay,
  };
}

function getWeekdayLabel(year, month, day) {
  const weekIndex = new Date(year, month, day).getDay();
  return weekDays[(weekIndex + 6) % 7];
}

function shouldRepeatOnDay(item, year, month, day) {
  if (!item.repeat || item.repeat === "없음") return false;
  const weekday = getWeekdayLabel(year, month, day);
  if (item.repeat === "매일") return day >= item.baseDay;
  if (item.repeat === "매주") return day >= item.baseDay && weekday === getWeekdayLabel(year, month, item.baseDay);
  if (item.repeat === "매월") return day === item.baseDay;
  if (item.repeat === "평일") return day >= item.baseDay && ["월", "화", "수", "목", "금"].includes(weekday);
  if (item.repeat === "사용자지정") return day >= item.baseDay && item.repeatDays.includes(weekday);
  return false;
}

function buildExpandedDateSchedules(dateSchedules, year, month) {
  const daysInMonth = getDaysInMonth(year, month);
  const expanded = {};
  for (let day = 1; day <= daysInMonth; day += 1) expanded[day] = [];

  Object.entries(dateSchedules).forEach(([key, list]) => {
    const baseDay = Number(key);
    (list || []).forEach((rawItem) => {
      const item = ensureRepeatMeta(rawItem, baseDay);
      expanded[baseDay].push({ ...item, sourceDay: baseDay, occurrenceDay: baseDay, occurrenceIndex: 0 });
      if (item.repeat && item.repeat !== "없음") {
        let occurrenceIndex = 1;
        for (let day = baseDay + 1; day <= daysInMonth; day += 1) {
          if (shouldRepeatOnDay(item, year, month, day)) {
            expanded[day].push({ ...item, sourceDay: baseDay, occurrenceDay: day, occurrenceIndex });
            occurrenceIndex += 1;
          }
        }
      }
    });
  });

  Object.keys(expanded).forEach((key) => {
    expanded[key] = expanded[key]
      .sort((a, b) => (a.time || "").localeCompare(b.time || ""))
      .map((item, idx) => ({ ...item, renderIndex: idx }));
  });

  return expanded;
}

function importScheduleItems(items) {
  const nextDateSchedules = {};
  const summary = [];
  let seed = Date.now();

  items.forEach((rawItem) => {
    const repeat = mapRepeatRule(rawItem.days);
    const baseDay = 20;
    const mappedBase = {
      sourceId: rawItem.id,
      title: rawItem.title || "새 일정",
      time: normalizeImportedTime(rawItem.start_time, rawItem.end_time, rawItem.duration_min),
      color: rawItem.priority === "high" ? "#ef5da8" : rawItem.priority === "medium" ? "#60a5fa" : "#d9d9d9",
      repeat,
      repeatDays: [],
      checked: false,
      checklist: splitChecklist(rawItem.checklist),
      priority: rawItem.priority || "medium",
      alerts: mapPriorityAlerts(rawItem.priority),
      notes: buildImportedNotes(rawItem),
      repeatGroupId: repeat !== "없음" ? `import-${rawItem.id || seed}` : null,
      occurrenceIndex: 0,
      baseDay,
      id: seed++,
    };
    nextDateSchedules[baseDay] = (nextDateSchedules[baseDay] || []).concat([mappedBase]);
    summary.push(`${mappedBase.title}: ${repeat} 반복`);
  });

  return { nextDateSchedules, summary };
}

function ColorPopover({ value, onChange, onClose }) {
  const popRef = useRef(null);
  const [hex, setHex] = useState(value || "#000000");

  useEffect(() => {
    setHex(value || "#000000");
  }, [value]);

  useEffect(() => {
    function handleDown(e) {
      if (popRef.current && !popRef.current.contains(e.target)) onClose();
    }
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  }, [onClose]);

  const rgb = hexToRgb(hex);

  function applyHex(nextHex) {
    const normalized = String(nextHex || "")
      .trim()
      .replace(/[^#0-9a-fA-F]/g, "")
      .replace(/^([^#])/, "#$1");
    const safe = /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized : hex;
    setHex(safe);
    onChange(safe);
  }

  function applyRgb(channel, nextValue) {
    const next = { ...rgb, [channel]: Math.max(0, Math.min(255, Number(nextValue) || 0)) };
    const nextHex = rgbToHex(next.r, next.g, next.b);
    setHex(nextHex);
    onChange(nextHex);
  }

  const presetColors = ["#ef5da8", "#60a5fa", "#22c55e", "#f59e0b", "#a855f7", "#111827", "#d9d9d9", "#ef4444"];

  return (
    <div ref={popRef} className="absolute right-0 top-8 z-20 w-[244px] rounded-[14px] border border-zinc-300 bg-white p-3 shadow-lg">
      <div className="mb-2 text-[11px] font-bold text-zinc-700">RGB 컬러 설정</div>
      <input type="color" value={hex} onChange={(e) => applyHex(e.target.value)} className="mb-3 h-10 w-full rounded border border-zinc-300 bg-white p-1" />
      <div className="mb-3 grid grid-cols-4 gap-2">
        {presetColors.map((preset) => (
          <button key={preset} type="button" onClick={() => applyHex(preset)} className={cls("h-7 rounded border", hex.toLowerCase() === preset.toLowerCase() ? "border-zinc-900" : "border-zinc-300")} style={{ backgroundColor: preset }} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[["r", rgb.r], ["g", rgb.g], ["b", rgb.b]].map(([key, num]) => (
          <label key={key} className="text-[10px] font-bold uppercase text-zinc-500">
            {key}
            <input type="number" min="0" max="255" value={num} onChange={(e) => applyRgb(key, e.target.value)} className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-[11px] text-zinc-700" />
          </label>
        ))}
      </div>
      <label className="mt-2 block text-[10px] font-bold text-zinc-500">
        HEX
        <input value={hex} onChange={(e) => setHex(e.target.value)} onBlur={() => applyHex(hex)} className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-[11px] font-semibold text-zinc-700" />
      </label>
    </div>
  );
}

function DeleteDialog({ open, item, onClose, onConfirm }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => dialogRef.current?.focus(), 0);
    function handleKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open, onClose]);

  if (!open || !item) return null;

  const repeatable = item.repeat && item.repeat !== "없음";
  const options = repeatable
    ? [
        { key: "single", label: "선택 항목 삭제", hint: "현재 선택된 일정만 삭제" },
        { key: "all", label: "전체 반복 삭제", hint: "같은 반복 그룹 일정 전체 삭제" },
        { key: "following", label: "이후 일정 삭제", hint: "현재 일정 포함 이후 반복 삭제" },
      ]
    : [{ key: "single", label: "선택 항목 삭제", hint: "현재 항목만 삭제" }];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div ref={dialogRef} tabIndex={-1} className="w-full max-w-[420px] rounded-[22px] border border-zinc-300 bg-white p-5 shadow-2xl outline-none">
        <div className="mb-1 text-[18px] font-extrabold text-zinc-900">삭제 옵션</div>
        <div className="mb-4 text-[12px] leading-5 text-zinc-600">{item.title || "선택 항목"} 삭제 범위를 선택하세요.</div>
        <div className="space-y-2">
          {options.map((option) => (
            <button key={option.key} onClick={() => onConfirm(option.key)} className="w-full rounded-[14px] border border-zinc-300 px-4 py-3 text-left hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-400">
              <div className="text-[14px] font-bold text-zinc-900">{option.label}</div>
              <div className="text-[11px] text-zinc-500">{option.hint}</div>
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="rounded-[12px] border border-zinc-300 px-4 py-2 text-[12px] font-bold text-zinc-700">취소</button>
        </div>
      </div>
    </div>
  );
}

function RepeatApplyDialog({ open, item, patch, onClose, onConfirm }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => dialogRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  if (!open || !item) return null;

  const label = patch?.repeat ? `반복: ${patch.repeat}` : "반복 일정 수정";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div ref={dialogRef} tabIndex={-1} className="w-full max-w-[420px] rounded-[22px] border border-zinc-300 bg-white p-5 shadow-2xl outline-none">
        <div className="mb-1 text-[18px] font-extrabold text-zinc-900">반복 수정 옵션</div>
        <div className="mb-1 text-[12px] text-zinc-600">{item.title}</div>
        <div className="mb-4 text-[12px] leading-5 text-zinc-500">{label} 변경 범위를 선택하세요.</div>
        <div className="space-y-2">
          <button onClick={() => onConfirm("single")} className="w-full rounded-[14px] border border-zinc-300 px-4 py-3 text-left hover:bg-zinc-50"><div className="text-[14px] font-bold">선택 일정만 적용</div><div className="text-[11px] text-zinc-500">현재 일정만 수정</div></button>
          <button onClick={() => onConfirm("following")} className="w-full rounded-[14px] border border-zinc-300 px-4 py-3 text-left hover:bg-zinc-50"><div className="text-[14px] font-bold">이후 일정 적용</div><div className="text-[11px] text-zinc-500">현재 포함 이후 반복 일정 수정</div></button>
          <button onClick={() => onConfirm("all")} className="w-full rounded-[14px] border border-zinc-300 px-4 py-3 text-left hover:bg-zinc-50"><div className="text-[14px] font-bold">전체 반복 적용</div><div className="text-[11px] text-zinc-500">같은 반복 그룹 전체 수정</div></button>
        </div>
        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="rounded-[12px] border border-zinc-300 px-4 py-2 text-[12px] font-bold text-zinc-700">취소</button>
        </div>
      </div>
    </div>
  );
}

function PolarClock({ selectedDate, selectedWeekday, dateItems, weekItems, currentTime, selectedScheduleId, selectedSchedule, onSelectDateSchedule, onSelectWeekSchedule, monthLabel, scheduleViewMode, selectedWeekdayKey, onDateMode, onWeekMode }) {
  const size = 690;
  const center = size / 2;
  const outerR = 276;
  const currentInner = 244;
  const dateOuter = 232;
  const dateInner = 188;
  const weekOuter = 176;
  const weekInner = 134;
  const coreR = 88;
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const isWeekMode = scheduleViewMode === "week";

  function renderArc(item, innerRadius, outerRadius, fill, active, onClick, keySuffix) {
    const parsed = parseTimeRange(item.time);
    if (!parsed) return null;
    return (
      <path
        key={`${item.id}-${keySuffix}`}
        d={buildArcPath(center, innerRadius, outerRadius, parsed.start, parsed.end)}
        fill={fill}
        opacity={active ? 1 : 0.9}
        stroke={active ? "#111" : "none"}
        strokeWidth={active ? 2.5 : 0}
        onClick={onClick}
        style={{ cursor: "pointer" }}
      />
    );
  }

  return (
    <div className="rounded-[18px] lg:rounded-[24px] border border-zinc-300 bg-zinc-100 p-2 sm:p-3 lg:p-4 h-full overflow-hidden">
      <div className="flex h-full flex-col items-center justify-center gap-2 lg:gap-3">
        <div className="flex items-center justify-center gap-4">
          <button onClick={onDateMode} className={cls("rounded-full border px-4 py-2 text-[12px] font-bold", !isWeekMode ? "border-pink-300 bg-pink-100 text-pink-700" : "border-zinc-300 bg-white text-zinc-600")}>날짜별</button>
          <button onClick={onWeekMode} className={cls("rounded-full border px-4 py-2 text-[12px] font-bold", isWeekMode ? "border-zinc-400 bg-zinc-200 text-zinc-700" : "border-zinc-300 bg-white text-zinc-600")}>요일별</button>
        </div>

        <div className="min-h-[46px] rounded-full border border-zinc-300 bg-white px-5 py-2 text-center">
          <div className="text-[11px] font-bold text-zinc-500">선택 일정</div>
          <div className="text-[14px] font-extrabold text-zinc-900">{selectedSchedule ? `${selectedSchedule.title}${selectedSchedule.time ? ` · ${selectedSchedule.time}` : ""}` : "선택된 일정 없음"}</div>
        </div>

        <div className="h-full w-full flex items-center justify-center">
          <svg viewBox={`0 0 ${size} ${size}`} className="w-full h-full max-w-[740px]">
            <circle cx={center} cy={center} r={outerR} fill="white" stroke="#b7b7b7" strokeWidth="1" />
            <circle cx={center} cy={center} r={currentInner} fill="white" stroke="#cfcfcf" strokeWidth="1" />
            <circle cx={center} cy={center} r={dateOuter} fill="none" stroke="#cfcfcf" strokeWidth="1" />
            <circle cx={center} cy={center} r={dateInner} fill="white" stroke="#cfcfcf" strokeWidth="1" />
            <circle cx={center} cy={center} r={weekOuter} fill="none" stroke="#cfcfcf" strokeWidth="1" />
            <circle cx={center} cy={center} r={weekInner} fill="white" stroke="#cfcfcf" strokeWidth="1" />
            <path d={buildArcPath(center, currentInner, outerR, 0, currentTime.hourValue)} fill="#cfe8f8" opacity="1" />
            {dateItems.map((item) => renderArc(item, dateInner, dateOuter, item.color || "#ef5da8", !isWeekMode && selectedScheduleId === item.id, () => onSelectDateSchedule(item.id), `${item.occurrenceDay || "date"}-${item.renderIndex || 0}`))}
            {weekItems.map((item, idx) => renderArc(item, weekInner, weekOuter, item.color || "#d9d9d9", isWeekMode && selectedScheduleId === item.id, () => onSelectWeekSchedule(item.id), `week-${selectedWeekdayKey}-${idx}`))}
            {hours.map((hour) => {
              const angle = (hour / 24) * Math.PI * 2 - Math.PI / 2;
              const x1 = center + weekInner * Math.cos(angle);
              const y1 = center + weekInner * Math.sin(angle);
              const x2 = center + outerR * Math.cos(angle);
              const y2 = center + outerR * Math.sin(angle);
              const tx = center + 292 * Math.cos(angle);
              const ty = center + 292 * Math.sin(angle);
              return (
                <g key={hour}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#ababab" strokeWidth="1" />
                  <text x={tx} y={ty} textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 12, fontWeight: 700, fill: "#111" }}>{hour}</text>
                </g>
              );
            })}
            <circle cx={center} cy={center} r={coreR} fill="white" stroke="#cfcfcf" strokeWidth="1" />
            <text x={center} y={center - 12} textAnchor="middle" style={{ fontSize: 25, fontWeight: 800, fill: "#111" }}>{isWeekMode ? selectedWeekdayKey : `${monthLabel}/${selectedDate}`}</text>
            <text x={center} y={center + 10} textAnchor="middle" style={{ fontSize: 14, fontWeight: 700, fill: "#222" }}>{isWeekMode ? "요일별 일정" : `${selectedWeekday}요일`}</text>
            <text x={center} y={center + 31} textAnchor="middle" style={{ fontSize: 14, fontWeight: 700, fill: "#222" }}>{currentTime.label}</text>
          </svg>
        </div>
      </div>
    </div>
  );
}

function MonthMiniCalendar({ year, month, selectedDate, isCenter, onSelectDate, dateSchedules }) {
  const cells = getMonthGrid(year, month);
  const title = `${year}년 ${month + 1}월`;
  return (
    <div className="rounded-[14px] border border-zinc-300 bg-white p-3 min-h-[178px]">
      <div className="text-center text-[12px] font-bold text-zinc-800 mb-2">{title}</div>
      <div className="grid grid-cols-7 gap-y-1 text-center text-[10px] font-semibold text-zinc-500 mb-1">{weekDays.map((day) => <div key={day}>{day}</div>)}</div>
      <div className="grid grid-cols-7 gap-y-1 text-center text-[10px]">
        {cells.map((cell, idx) => {
          const isSelected = isCenter && cell.type === "current" && cell.day === selectedDate;
          const marks = cell.type === "current" ? (dateSchedules[cell.day] || []).slice(0, 2) : [];
          return (
            <button key={idx} onClick={() => cell.type === "current" && onSelectDate(cell.day)} className={cls("relative mx-auto flex h-5 w-5 items-center justify-center rounded-md focus:outline-none focus:ring-2 focus:ring-blue-400", cell.type === "current" ? "text-zinc-900" : "text-zinc-300", isSelected && "border border-blue-500 text-blue-700 bg-blue-50 font-bold")}>
              <span>{cell.day}</span>
              {marks.length > 0 ? <span className="absolute -bottom-1 left-1/2 flex -translate-x-1/2 gap-[2px]">{marks.map((m, mIdx) => <span key={`${m.id}-${mIdx}`} className="h-[3px] w-[3px] rounded-full" style={{ backgroundColor: m.color }} />)}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CalendarPanel({ currentMonth, setCurrentMonth, selectedDate, setSelectedDate, expandedDateSchedules, todoMode, setTodoMode, onBackup, onRestoreClick }) {
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const yearWeek = getWeekOfYear(new Date(year, month, selectedDate));
  const monthSet = [new Date(year, month - 1, 1), new Date(year, month, 1), new Date(year, month + 1, 1)];
  return (
    <div className="rounded-[24px] border border-zinc-300 bg-zinc-100 p-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        <div className="flex-1">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[18px] font-bold text-zinc-900">달력</div>
            <div className="flex items-center gap-2">
              <div className="text-[12px] font-bold text-zinc-600">{`${year}년 / ${yearWeek}/52주`}</div>
              <button className="w-6 h-6 rounded-full border border-zinc-300 bg-white flex items-center justify-center text-zinc-500" onClick={() => setCurrentMonth(new Date(year, month - 1, 1))}><ChevronLeft className="w-4 h-4" /></button>
              <button className="w-6 h-6 rounded-full border border-zinc-300 bg-white flex items-center justify-center text-zinc-500" onClick={() => setCurrentMonth(new Date(year, month + 1, 1))}><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{monthSet.map((m, idx) => <MonthMiniCalendar key={`${m.getFullYear()}-${m.getMonth()}`} year={m.getFullYear()} month={m.getMonth()} selectedDate={selectedDate} isCenter={idx === 1} onSelectDate={setSelectedDate} dateSchedules={idx === 1 ? expandedDateSchedules : {}} />)}</div>
        </div>
        <div className="w-full flex flex-col gap-2 pt-0 xl:w-[146px] xl:pt-8">
          <button onClick={onBackup} className="h-[46px] rounded-[14px] border border-zinc-300 bg-white text-[14px] font-extrabold text-zinc-900">JSON 백업</button>
          <div>
            <button onClick={onRestoreClick} className="h-[46px] w-full rounded-[14px] border border-zinc-300 bg-white text-[14px] font-extrabold text-zinc-900">JSON 복원</button>
            <div className="mt-1 text-[10px] font-semibold text-zinc-500">백업 JSON 또는 일정 배열 JSON 가져오기</div>
          </div>
          <button onClick={() => setTodoMode(!todoMode)} className={cls("h-[46px] rounded-[14px] border text-[14px] font-extrabold", todoMode ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 bg-white text-zinc-900")}>TO-DO</button>
        </div>
      </div>
    </div>
  );
}

function CollapsiblePanel({ title, open, onToggle, children }) {
  return (
    <div className="rounded-[24px] border border-zinc-300 bg-zinc-100 p-4">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between"
      >
        <div className="font-bold">{title}</div>
        <div>{open ? "닫기" : "열기"}</div>
      </button>
      {open && <div className="mt-4">{children}</div>}
    </div>
  );
}

function WeekdaySelector({ value, onToggle, disabled, selectedDay, onSelectDay, mode = "repeat" }) {
  return (
    <div className="flex items-center gap-1 flex-wrap justify-end">
      {weekDays.map((day) => {
        const safeValue = Array.isArray(value) ? value : [];
        const active = mode === "repeat" ? safeValue.includes(day) : selectedDay === day;
        return (
          <button
            key={day}
            type="button"
            disabled={disabled}
            onClick={() => {
              if (mode === "repeat") onToggle(day);
              else onSelectDay(day);
            }}
            className={cls("h-8 min-w-8 rounded-full border px-2 text-[11px] font-bold", active ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 bg-white text-zinc-600", disabled && "opacity-50")}
          >
            {day}
          </button>
        );
      })}
    </div>
  );
}

function SectionEditor({ title, items, selectedId, setSelectedId, onToggle, onUpdate, onDelete, showColor = false, showTime = false, showRepeat = false, checkLast = false, listId, onKeyboardFocus, headerRight = null, onAdd = null }) {
  const [editingId, setEditingId] = useState(null);
  const [checklistInput, setChecklistInput] = useState("");
  const [colorTargetId, setColorTargetId] = useState(null);
  const itemRefs = useRef({});
  const safeItems = Array.isArray(items) ? items : [];
  const selectedItem = safeItems.find((item) => item?.id === selectedId) || safeItems[0] || null;
  const orderedItems = safeItems.slice().sort((a, b) => Number(a?.checked) - Number(b?.checked));

  useEffect(() => {
    if (selectedItem && editingId === selectedItem.id) {
      setChecklistInput(Array.isArray(selectedItem.checklist) ? selectedItem.checklist.map((e) => e.label).join("\n") : "");
    }
  }, [selectedItem, editingId]);

  function moveSelection(direction) {
    if (!orderedItems.length) return;
    const currentIndex = orderedItems.findIndex((item) => item.id === selectedId);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = direction === "up" ? Math.max(0, safeIndex - 1) : Math.min(orderedItems.length - 1, safeIndex + 1);
    setSelectedId(orderedItems[nextIndex].id);
    requestAnimationFrame(() => itemRefs.current[orderedItems[nextIndex].id]?.focus());
  }

  function openEdit(itemId) {
    setSelectedId(itemId);
    setEditingId(itemId);
  }

  function closeEdit() {
    setEditingId(null);
  }

  function handleListItemKeyDown(e, item) {
    if (editingId === item.id) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeEdit();
        requestAnimationFrame(() => itemRefs.current[item.id]?.focus());
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection("up");
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection("down");
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      openEdit(item.id);
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      onToggle(item.id);
      return;
    }
    if (e.key === "Delete") {
      e.preventDefault();
      onDelete(item.id);
    }
  }

  return (
    <div className="rounded-[24px] border border-zinc-300 bg-zinc-100 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="text-[18px] font-bold text-zinc-900">{title}</div>
        </div>
        {headerRight}
      </div>

      <div className="grid grid-cols-2 gap-4 min-h-[280px]">
        <div className="rounded-[18px] bg-white border border-zinc-300 p-3 h-[332px] overflow-y-auto flex flex-col">
          <div className="mb-2 rounded-[12px] border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-[11px] leading-5 text-zinc-500">
            ↑↓ 이동 · Enter 편집 · Space 체크 · Delete 삭제
          </div>
          <div className="space-y-2 pb-2 flex-1" role="listbox" aria-label={`${title} 리스트`}>
            {orderedItems.map((item) => {
              const editing = editingId === item.id;
              return (
                <div
                  key={`${item.id}-${item.occurrenceDay || item.baseDay || item.id}`}
                  ref={(node) => {
                    itemRefs.current[item.id] = node;
                  }}
                  tabIndex={selectedId === item.id ? 0 : -1}
                  data-listid={listId}
                  role="option"
                  aria-selected={selectedId === item.id}
                  onFocus={() => {
                    setSelectedId(item.id);
                    onKeyboardFocus?.(listId);
                  }}
                  onClick={() => setSelectedId(item.id)}
                  onDoubleClick={() => openEdit(item.id)}
                  onKeyDown={(e) => handleListItemKeyDown(e, item)}
                  className={cls("rounded-[12px] border-b border-dashed border-zinc-300 pb-3 pt-1 px-1 cursor-pointer outline-none focus:ring-2 focus:ring-zinc-400", selectedId === item.id && "bg-zinc-50")}
                >
                  <div className="flex items-start gap-2">
                    {!checkLast ? <input type="checkbox" checked={item.checked} onChange={() => onToggle(item.id)} className="mt-1 h-4 w-4" /> : null}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 justify-between">
                        <input
                          value={item.title}
                          readOnly={!editing}
                          onChange={(e) => onUpdate(item.id, { title: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.preventDefault();
                              closeEdit();
                              requestAnimationFrame(() => itemRefs.current[item.id]?.focus());
                            }
                          }}
                          className={cls("w-full bg-transparent text-[15px] font-bold text-zinc-900 outline-none", !editing && "pointer-events-none")}
                        />
                        <div className="flex items-center gap-2 shrink-0">
                          {showColor ? (
                            <div className="relative shrink-0">
                              <button onClick={(e) => { e.stopPropagation(); setColorTargetId(colorTargetId === item.id ? null : item.id); }} className="h-6 w-6 rounded border border-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-400" style={{ backgroundColor: item.color }} aria-label="색상 선택" />
                              {colorTargetId === item.id ? <ColorPopover value={item.color} onChange={(hex) => onUpdate(item.id, { color: hex })} onClose={() => setColorTargetId(null)} /> : null}
                            </div>
                          ) : null}
                          <button onClick={(e) => { e.stopPropagation(); onDelete(item.id); }} className="h-6 w-6 rounded border border-zinc-300 text-[11px] font-bold text-zinc-500 hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-400" aria-label="삭제">×</button>
                        </div>
                      </div>
                      {showTime ? <input value={displayCompactTime(item.time || "")} readOnly={!editing} onChange={(e) => onUpdate(item.id, { time: formatCompactTime(normalizeTimeInput(e.target.value)) })} placeholder="00:00-00:00" className={cls("mt-1 w-full bg-transparent text-[11px] font-semibold text-zinc-500 outline-none", !editing && "pointer-events-none")} /> : null}
                      {showRepeat ? (
                        <div className="mt-1 flex items-center gap-2">
                          <select value={item.repeat || "없음"} disabled={!editing} onChange={(e) => onUpdate(item.id, { repeat: e.target.value, repeatDays: e.target.value === "사용자지정" ? item.repeatDays || [] : [] })} className={cls("w-full bg-transparent text-[11px] font-semibold text-zinc-500 outline-none", !editing && "pointer-events-none")}>
                            {REPEAT_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                          </select>
                          <span className="text-[10px] text-zinc-400">{item.repeat === "사용자지정" && item.repeatDays?.length ? item.repeatDays.join(",") : ""}</span>
                        </div>
                      ) : null}
                    </div>
                    {checkLast ? <input type="checkbox" checked={item.checked} onChange={() => onToggle(item.id)} className="mt-1 h-4 w-4" /> : null}
                  </div>
                </div>
              );
            })}
          </div>
          {onAdd ? <button onClick={onAdd} className="mt-3 h-[42px] rounded-[12px] border border-zinc-300 bg-white text-[12px] font-bold text-zinc-700 hover:bg-zinc-50">{getAddButtonLabel(title)}</button> : null}
        </div>

        <div onDoubleClick={() => selectedItem && setEditingId(selectedItem.id)} className="rounded-[18px] bg-white border border-zinc-300 p-4 h-[332px] overflow-y-auto">
          {selectedItem ? (
            <>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[20px] font-extrabold text-zinc-900">• {selectedItem.title || "제목 없음"}</div>
                  {showTime ? <div className="mt-1 text-[11px] font-semibold text-zinc-500">{selectedItem.time || "시간 미지정"}{showRepeat && selectedItem.repeat && selectedItem.repeat !== "없음" ? ` · ${selectedItem.repeat}` : ""}</div> : null}
                </div>
                {showColor ? <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: selectedItem.color }} /> : null}
              </div>
              {Array.isArray(selectedItem.checklist) && selectedItem.checklist.length ? (
                <div className="mb-4 space-y-1">
                  {selectedItem.checklist.map((entry) => (
                    <label key={entry.id} className="flex items-center gap-2 text-[12px] text-zinc-700">
                      <input type="checkbox" checked={entry.checked} onChange={() => onUpdate(selectedItem.id, { checklist: selectedItem.checklist.map((x) => x.id === entry.id ? { ...x, checked: !x.checked } : x) })} />
                      <span>{entry.label}</span>
                    </label>
                  ))}
                </div>
              ) : null}
              {showTime ? (
                <div className="mb-3 space-y-3">
                  <div>
                    <div className="mb-1 text-[11px] font-bold text-zinc-500">체크리스트</div>
                    <textarea
                      value={editingId === selectedItem.id ? checklistInput : (Array.isArray(selectedItem.checklist) ? selectedItem.checklist.map((e) => e.label).join("\n") : "")}
                      readOnly={editingId !== selectedItem.id}
                      onChange={(e) => setChecklistInput(e.target.value)}
                      onBlur={() => {
                        if (editingId === selectedItem.id) {
                          const list = checklistInput.split("\n").map((v, i) => ({ id: i + 1, label: v.trim(), checked: false })).filter((v) => v.label);
                          onUpdate(selectedItem.id, { checklist: list });
                        }
                      }}
                      className="w-full rounded border border-zinc-300 px-3 py-2 text-[12px] text-zinc-700 outline-none min-h-[80px]"
                      placeholder="엔터로 항목 추가
예: 물 1잔"
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-[11px] font-bold text-zinc-500">일정 알림</div>
                    <div className="flex flex-wrap gap-2">
                      {DEFAULT_ALERT_OPTIONS.map((alertLabel) => {
                        const active = (selectedItem.alerts || []).includes(alertLabel);
                        return (
                          <button
                            key={alertLabel}
                            type="button"
                            onClick={() => {
                              if (alertLabel === "없음") {
                                onUpdate(selectedItem.id, { alerts: [] });
                                return;
                              }
                              const currentAlerts = (selectedItem.alerts || []).filter((x) => x !== "없음");
                              const nextAlerts = active ? currentAlerts.filter((x) => x !== alertLabel) : [...currentAlerts, alertLabel];
                              onUpdate(selectedItem.id, { alerts: dedupeAlerts(nextAlerts) });
                            }}
                            className={cls("rounded-full border px-3 py-1 text-[11px] font-bold", active ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 bg-white text-zinc-600")}
                          >
                            {alertLabel}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : null}
              <textarea value={selectedItem.notes || ""} readOnly={editingId !== selectedItem.id} onChange={(e) => onUpdate(selectedItem.id, { notes: e.target.value })} className="min-h-[220px] w-full resize-none bg-transparent text-[13px] leading-6 text-zinc-800 outline-none" placeholder="내용을 입력하세요" />
            </>
          ) : <div className="py-10 text-center text-sm text-zinc-500">항목을 선택하세요.</div>}
        </div>
      </div>
    </div>
  );
}

export default function SchedulerAppV2() {
  const saved = typeof window !== "undefined" ? loadSavedState() : null;
  const normalizedSaved = unwrapPersistedPayload(saved);
  const fileInputRef = useRef(null);
  const [currentMonth, setCurrentMonth] = useState(normalizedSaved?.currentMonth ? new Date(normalizedSaved.currentMonth) : new Date(2026, 2, 1));
  const [openAlertPanel, setOpenAlertPanel] = useState(true);
  const [openDrivePanel, setOpenDrivePanel] = useState(true);
  const [openCalendarPanel, setOpenCalendarPanel] = useState(true);
  const [openSchedulePanel, setOpenSchedulePanel] = useState(true);
  const [openGoalPanel, setOpenGoalPanel] = useState(true);
  const [openTodoPanel, setOpenTodoPanel] = useState(true);
  const [isMobileLayout, setIsMobileLayout] = useState(() => (typeof window !== "undefined" ? window.innerWidth <= 1024 : false));
  const [selectedDate, setSelectedDate] = useState(normalizedSaved?.selectedDate ?? 20);
  const [dateSchedules, setDateSchedules] = useState(() => {
    const source = normalizedSaved?.dateSchedules ?? initialDateSchedules;
    return Object.fromEntries(Object.entries(source).map(([key, list]) => [key, (list || []).map((item) => ensureRepeatMeta(item, Number(key)))]));
  });
  const [weekSchedules, setWeekSchedules] = useState(() => {
    const source = normalizedSaved?.weekSchedules ?? initialWeekSchedules;
    return Object.fromEntries(Object.entries(source).map(([key, list]) => [key, list || []]));
  });
  const [scheduleViewMode, setScheduleViewMode] = useState(normalizedSaved?.scheduleViewMode ?? "date");
  const [selectedWeekdayKey, setSelectedWeekdayKey] = useState(normalizedSaved?.selectedWeekdayKey ?? "월");
  const [selectedWeekScheduleId, setSelectedWeekScheduleId] = useState(normalizedSaved?.selectedWeekScheduleId ?? null);
  const [goals, setGoals] = useState(normalizedSaved?.goals ?? initialGoals);
  const [todos, setTodos] = useState(normalizedSaved?.todos ?? initialTodos);
  const [todoMode, setTodoMode] = useState(normalizedSaved?.todoMode ?? false);
  const [selectedDateScheduleId, setSelectedDateScheduleId] = useState(normalizedSaved?.selectedDateScheduleId ?? initialDateSchedules[20][0].id);
  const [selectedGoalId, setSelectedGoalId] = useState(normalizedSaved?.selectedGoalId ?? initialGoals[0].id);
  const [selectedTodoId, setSelectedTodoId] = useState(normalizedSaved?.selectedTodoId ?? initialTodos[0].id);
  const [currentTime, setCurrentTime] = useState({ label: "00:00", hourValue: 0 });
  const [importSummary, setImportSummary] = useState([]);
  const [deleteState, setDeleteState] = useState({ open: false, item: null });
  const [repeatApplyState, setRepeatApplyState] = useState({ open: false, item: null, patch: null });
  const [activeList, setActiveList] = useState("schedule");
  const [lastSavedAt, setLastSavedAt] = useState(saved?.updatedAt || null);
  const [driveMeta, setDriveMeta] = useState(() => loadDriveMeta() || { connected: false, fileName: "scheduler-sync.json", provider: "google-drive" });
  const [syncStatus, setSyncStatus] = useState("로컬 저장 중");
  const [googleAuthReady, setGoogleAuthReady] = useState(false);
  const [googleAccessToken, setGoogleAccessToken] = useState("");
  const [driveFileId, setDriveFileId] = useState("");
  const [lastDriveCheckAt, setLastDriveCheckAt] = useState("");
  const [pendingSync, setPendingSync] = useState(false);
  const tokenClientRef = useRef(null);
  const autoSyncTimerRef = useRef(null);
  const [driveConfig, setDriveConfig] = useState(() => loadDriveConfig() || {
    clientId: "",
    apiKey: "",
    appFolder: "Scheduler App V2",
    autoSync: false,
    conflictPolicy: "newer-wins",
  });
  const [backupStatus, setBackupStatus] = useState("백업 대기");
  const [backupHistory, setBackupHistory] = useState(() => loadBackupHistory());
  const [notificationPermission, setNotificationPermission] = useState(getNotificationPermissionSafe());
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [googleCalendarReady, setGoogleCalendarReady] = useState(false);
  const [calendarSyncStatus, setCalendarSyncStatus] = useState("미연결");
  const notifiedAlertsRef = useRef(new Set());
  const periodicBackupTimerRef = useRef(null);

  const expandedDateSchedules = useMemo(() => buildExpandedDateSchedules(dateSchedules, currentMonth.getFullYear(), currentMonth.getMonth()), [dateSchedules, currentMonth]);
  const selectedWeekday = useMemo(() => getWeekdayLabel(currentMonth.getFullYear(), currentMonth.getMonth(), selectedDate), [currentMonth, selectedDate]);
  const dateScheduleItems = useMemo(() => (expandedDateSchedules?.[selectedDate] || []), [expandedDateSchedules, selectedDate]);
  const weekScheduleItems = useMemo(() => (weekSchedules?.[selectedWeekdayKey] || []), [weekSchedules, selectedWeekdayKey]);
  const scheduleItems = scheduleViewMode === "date" ? dateScheduleItems : weekScheduleItems;
  const selectedSchedule = (scheduleViewMode === "date" ? dateScheduleItems.find((item) => item?.id === selectedDateScheduleId) : weekScheduleItems.find((item) => item?.id === selectedWeekScheduleId)) || scheduleItems[0] || null;
  const safeGoals = Array.isArray(goals) ? goals : [];
  const safeTodos = Array.isArray(todos) ? todos : [];
  const safeImportSummary = Array.isArray(importSummary) ? importSummary : [];
  const safeBackupHistory = Array.isArray(backupHistory) ? backupHistory : [];
  const selectedGoal = safeGoals.find((item) => item?.id === selectedGoalId) || safeGoals[0] || null;
  const selectedTodo = safeTodos.find((item) => item?.id === selectedTodoId) || safeTodos[0] || null;
  const viewportClockSize = useMemo(() => {
    if (typeof window === "undefined") return 520;
    return Math.max(280, Math.min(window.innerWidth - 16, isMobileLayout ? 520 : 920));
  }, [isMobileLayout, currentMonth, selectedDate, selectedWeekdayKey, scheduleViewMode]);

  useEffect(() => {
    if (dateScheduleItems.length && !dateScheduleItems.some((item) => item.id === selectedDateScheduleId)) setSelectedDateScheduleId(dateScheduleItems[0].id);
    if (!dateScheduleItems.length) setSelectedDateScheduleId(null);
    if (weekScheduleItems.length && !weekScheduleItems.some((item) => item.id === selectedWeekScheduleId)) setSelectedWeekScheduleId(weekScheduleItems[0].id);
    if (!weekScheduleItems.length) setSelectedWeekScheduleId(null);
    if (safeGoals.length && !safeGoals.some((item) => item.id === selectedGoalId)) setSelectedGoalId(safeGoals[0].id);
    if (safeTodos.length && !safeTodos.some((item) => item.id === selectedTodoId)) setSelectedTodoId(safeTodos[0].id);
  }, [dateScheduleItems, weekScheduleItems, safeGoals, safeTodos, selectedDateScheduleId, selectedWeekScheduleId, selectedGoalId, selectedTodoId]);

  useEffect(() => {
    function handleResize() {
      if (typeof window === "undefined") return;
      setIsMobileLayout(window.innerWidth <= 1024);
    }

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (isMobileLayout) {
      setOpenAlertPanel(false);
      setOpenDrivePanel(false);
      setOpenCalendarPanel(true);
      setOpenSchedulePanel(true);
      setOpenGoalPanel(false);
      setOpenTodoPanel(false);
    } else {
      setOpenAlertPanel(true);
      setOpenDrivePanel(true);
      setOpenCalendarPanel(true);
      setOpenSchedulePanel(true);
      setOpenGoalPanel(true);
      setOpenTodoPanel(true);
    }
  }, [isMobileLayout]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      setCurrentTime({ label: now.toTimeString().slice(0, 5), hourValue: now.getHours() + now.getMinutes() / 60 });
    }, 30000);
    const now = new Date();
    setCurrentTime({ label: now.toTimeString().slice(0, 5), hourValue: now.getHours() + now.getMinutes() / 60 });
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const statePayload = { currentMonth: currentMonth.toISOString(), selectedDate, dateSchedules, weekSchedules, scheduleViewMode, selectedWeekdayKey, selectedDateScheduleId, selectedWeekScheduleId, goals, todos, todoMode, selectedGoalId, selectedTodoId };
    const wrapped = buildPersistedPayload(statePayload);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(wrapped));
    setLastSavedAt(wrapped.updatedAt);
    setSyncStatus(driveMeta?.connected ? "로컬 저장 완료 · Drive 동기화 대기" : "로컬 저장 완료");
  }, [currentMonth, selectedDate, dateSchedules, weekSchedules, scheduleViewMode, selectedWeekdayKey, selectedDateScheduleId, selectedWeekScheduleId, goals, todos, todoMode, selectedGoalId, selectedTodoId, driveMeta?.connected]);

  useEffect(() => {
    if (periodicBackupTimerRef.current) clearInterval(periodicBackupTimerRef.current);
    periodicBackupTimerRef.current = setInterval(() => {
      const snapshot = buildPersistedPayload(getCurrentStateSnapshot());
      const nextHistory = pushLocalBackupSnapshot(snapshot);
      setBackupHistory(nextHistory);
      setBackupStatus(`자동 백업 완료 · ${new Date().toLocaleTimeString()}`);
    }, 1000 * 60 * 10);
    return () => {
      if (periodicBackupTimerRef.current) clearInterval(periodicBackupTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setNotificationPermission(getNotificationPermissionSafe());
  }, []);

  useEffect(() => {
    if (!notificationsEnabled) return;
    if (notificationPermission !== "granted") return;
    const now = new Date();
    const currentList = scheduleViewMode === "date" ? dateScheduleItems : weekScheduleItems;
    currentList.forEach((item) => {
      const baseDate = scheduleViewMode === "date"
        ? new Date(currentMonth.getFullYear(), currentMonth.getMonth(), item.occurrenceDay || selectedDate)
        : new Date(currentMonth.getFullYear(), currentMonth.getMonth(), selectedDate);
      const startAt = parseTimeStartToDate(baseDate, item.time);
      if (!startAt) return;
      const alerts = dedupeAlerts(item.alerts && item.alerts.length ? item.alerts : ["시작 시각"]);
      alerts.forEach((alertLabel) => {
        const mins = alertLabelToMinutes(alertLabel);
        if (mins === null) return;
        const triggerAt = new Date(startAt.getTime() - mins * 60000);
        const diff = Math.abs(now.getTime() - triggerAt.getTime());
        const key = `${item.id}-${alertLabel}-${baseDate.toDateString()}`;
        if (diff <= 30000 && !notifiedAlertsRef.current.has(key)) {
          new Notification(item.title || "일정 알림", {
            body: `${alertLabel}${item.time ? ` · ${item.time}` : ""}`,
          });
          notifiedAlertsRef.current.add(key);
        }
      });
    });
  }, [notificationsEnabled, notificationPermission, scheduleViewMode, dateScheduleItems, weekScheduleItems, currentMonth, selectedDate]);

  useEffect(() => {
    function handleKey(e) {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (deleteState.open || repeatApplyState.open) return;
      if (e.altKey && e.key === "1") {
        e.preventDefault();
        setTodoMode(false);
        setActiveList("schedule");
      }
      if (e.altKey && e.key === "2") {
        e.preventDefault();
        setTodoMode(false);
        setActiveList("goal");
      }
      if (e.altKey && e.key === "3") {
        e.preventDefault();
        setTodoMode(true);
        setActiveList("todo");
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [deleteState.open, repeatApplyState.open]);

  function updateBaseDayItems(baseDay, updater) {
    setDateSchedules((prev) => ({ ...prev, [baseDay]: updater(prev[baseDay] || []) }));
  }

  function applyPatchByScope(item, patch, scope) {
    if (!item) return;
    setDateSchedules((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((dayKey) => {
        next[dayKey] = (next[dayKey] || []).map((entry) => {
          if (scope === "single") return Number(dayKey) === item.sourceDay && entry.id === item.id ? ensureRepeatMeta({ ...entry, ...patch }, Number(dayKey)) : entry;
          if (scope === "all") return entry.repeatGroupId && entry.repeatGroupId === item.repeatGroupId ? ensureRepeatMeta({ ...entry, ...patch }, Number(dayKey)) : entry;
          if (scope === "following") return entry.repeatGroupId && entry.repeatGroupId === item.repeatGroupId && Number(dayKey) >= item.sourceDay ? ensureRepeatMeta({ ...entry, ...patch }, Number(dayKey)) : entry;
          return entry;
        });
      });
      return next;
    });
  }

  function requestDateScheduleUpdate(itemId, patch) {
    const item = dateScheduleItems.find((entry) => entry.id === itemId);
    if (!item) return;
    const baseDay = item.sourceDay;
    const baseEntry = (dateSchedules[baseDay] || []).find((entry) => entry.id === item.id);
    if (!baseEntry) return;
    const repeatSensitive = baseEntry.repeat && baseEntry.repeat !== "없음";
    if (repeatSensitive && isRepeatScopePatch(patch)) {
      setRepeatApplyState({ open: true, item, patch });
      return;
    }
    updateBaseDayItems(baseDay, (items) => items.map((entry) => entry.id === item.id ? ensureRepeatMeta({ ...entry, ...patch }, baseDay) : entry));
  }

  function requestWeekScheduleUpdate(itemId, patch) {
    setWeekSchedules((prev) => ({ ...prev, [selectedWeekdayKey]: (prev[selectedWeekdayKey] || []).map((entry) => entry.id === itemId ? { ...entry, ...patch } : entry) }));
  }

  function addDateItem() {
    const id = Date.now();
    const newItem = ensureRepeatMeta({ id, title: "새 일정", time: "", color: "#ef5da8", repeat: "없음", repeatDays: [], notes: "", checklist: [], alerts: [], checked: false, baseDay: selectedDate }, selectedDate);
    updateBaseDayItems(selectedDate, (items) => items.concat([newItem]));
    setSelectedDateScheduleId(id);
    setActiveList("schedule");
  }

  function addWeekItem() {
    const id = Date.now();
    const newItem = { id, title: "새 요일 일정", time: "", color: "#d9d9d9", repeat: "매주", repeatDays: [], notes: "", checklist: [], alerts: [], checked: false };
    setWeekSchedules((prev) => ({ ...prev, [selectedWeekdayKey]: [...(prev[selectedWeekdayKey] || []), newItem] }));
    setSelectedWeekScheduleId(id);
    setActiveList("schedule");
  }

  function toggleDateItem(id) {
    const item = dateScheduleItems.find((entry) => entry.id === id);
    if (!item) return;
    updateBaseDayItems(item.sourceDay, (items) => items.map((entry) => entry.id === id ? { ...entry, checked: !entry.checked } : entry));
  }

  function toggleWeekItem(id) {
    setWeekSchedules((prev) => ({ ...prev, [selectedWeekdayKey]: (prev[selectedWeekdayKey] || []).map((entry) => entry.id === id ? { ...entry, checked: !entry.checked } : entry) }));
  }

  function requestDeleteDateItem(id) {
    const item = dateScheduleItems.find((entry) => entry.id === id);
    if (item) setDeleteState({ open: true, item });
  }

  function requestDeleteWeekItem(id) {
    const item = weekScheduleItems.find((entry) => entry.id === id);
    if (item) setDeleteState({ open: true, item: { ...item, repeat: "없음", weekMode: true } });
  }

  function confirmDelete(optionKey) {
    const item = deleteState.item;
    if (!item) return;
    if (item.weekMode) {
      setWeekSchedules((prev) => ({ ...prev, [selectedWeekdayKey]: (prev[selectedWeekdayKey] || []).filter((entry) => entry.id !== item.id) }));
      if (selectedWeekScheduleId === item.id) setSelectedWeekScheduleId(null);
      setDeleteState({ open: false, item: null });
      return;
    }

    setDateSchedules((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((dayKey) => {
        next[dayKey] = (next[dayKey] || []).filter((entry) => {
          if (optionKey === "single" || !item.repeatGroupId) return !(Number(dayKey) === item.sourceDay && entry.id === item.id);
          if (optionKey === "all") return entry.repeatGroupId !== item.repeatGroupId;
          if (optionKey === "following") return !(entry.repeatGroupId === item.repeatGroupId && Number(dayKey) >= item.sourceDay);
          return true;
        });
      });
      return next;
    });
    if (selectedDateScheduleId === item.id) setSelectedDateScheduleId(null);
    setDeleteState({ open: false, item: null });
  }

  function toggleGoal(id) {
    setGoals((prev) => prev.map((item) => item.id === id ? { ...item, checked: !item.checked } : item));
  }

  function addGoal() {
    const newItem = { id: Date.now(), title: "새 목표", notes: "", checked: false };
    setGoals((prev) => prev.concat([newItem]));
    setSelectedGoalId(newItem.id);
    setActiveList("goal");
  }

  function updateGoal(id, patch) {
    setGoals((prev) => prev.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function requestDeleteGoal(id) {
    const item = safeGoals.find((entry) => entry.id === id);
    if (item) setDeleteState({ open: true, item: { ...item, repeat: "없음" } });
  }

  function toggleTodo(id) {
    setTodos((prev) => prev.map((item) => item.id === id ? { ...item, checked: !item.checked } : item));
  }

  function addTodo() {
    const newItem = { id: Date.now(), title: "새 TO-DO", notes: "", checked: false };
    setTodos((prev) => prev.concat([newItem]));
    setSelectedTodoId(newItem.id);
    setActiveList("todo");
  }

  function updateTodo(id, patch) {
    setTodos((prev) => prev.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function requestDeleteTodo(id) {
    const item = safeTodos.find((entry) => entry.id === id);
    if (item) setDeleteState({ open: true, item: { ...item, repeat: "없음" } });
  }

  function getCurrentStateSnapshot() {
    return { currentMonth: currentMonth.toISOString(), selectedDate, dateSchedules, weekSchedules, scheduleViewMode, selectedWeekdayKey, selectedDateScheduleId, selectedWeekScheduleId, goals, todos, todoMode, selectedGoalId, selectedTodoId };
  }

  function backupAll() {
    const payload = { currentMonth: currentMonth.toISOString(), selectedDate, dateSchedules, weekSchedules, scheduleViewMode, selectedWeekdayKey, selectedDateScheduleId, selectedWeekScheduleId, goals, todos, todoMode, selectedGoalId, selectedTodoId };
    downloadJson("scheduler-backup.json", payload);
    const nextHistory = pushLocalBackupSnapshot(buildPersistedPayload(payload));
    setBackupHistory(nextHistory);
    setBackupStatus(`수동 백업 완료 · ${new Date().toLocaleTimeString()}`);
  }

  async function requestNotificationPermission() {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setNotificationPermission("unsupported");
      return;
    }
    const result = await Notification.requestPermission();
    setNotificationPermission(result);
    if (result === "granted") {
      setNotificationsEnabled(true);
    }
  }

  function updateSelectedScheduleAlerts(nextAlerts) {
    const cleaned = dedupeAlerts(nextAlerts);
    if (!selectedSchedule) return;
    if (scheduleViewMode === "date") {
      requestDateScheduleUpdate(selectedSchedule.id, { alerts: cleaned });
    } else {
      requestWeekScheduleUpdate(selectedSchedule.id, { alerts: cleaned });
    }
  }

  useEffect(() => {
    setPendingSync(true);
  }, [currentMonth, selectedDate, dateSchedules, weekSchedules, scheduleViewMode, selectedWeekdayKey, selectedDateScheduleId, selectedWeekScheduleId, goals, todos, todoMode, selectedGoalId, selectedTodoId]);

  useEffect(() => {
    if (!pendingSync) return;
    if (!driveConfig?.autoSync) return;
    if (!googleAccessToken) return;
    if (!driveMeta?.connected) return;
    if (autoSyncTimerRef.current) clearTimeout(autoSyncTimerRef.current);
    setSyncStatus("자동 동기화 대기 중");
    autoSyncTimerRef.current = setTimeout(async () => {
      try {
        await manualDriveSync();
      } finally {
        setPendingSync(false);
      }
    }, 1200);
    return () => {
      if (autoSyncTimerRef.current) clearTimeout(autoSyncTimerRef.current);
    };
  }, [pendingSync, driveConfig?.autoSync, googleAccessToken, driveMeta?.connected, currentMonth, selectedDate, dateSchedules, weekSchedules, scheduleViewMode, selectedWeekdayKey, selectedDateScheduleId, selectedWeekScheduleId, goals, todos, todoMode, selectedGoalId, selectedTodoId]);

  useEffect(() => {
    if (!googleAccessToken) return;
    if (!driveConfig?.autoSync) return;
    if (!driveMeta?.connected) return;
    const timer = setTimeout(() => {
      downloadLatestDriveFile();
    }, 1500);
    return () => clearTimeout(timer);
  }, [googleAccessToken]);

  async function connectGoogleCalendar() {
    const clientId = String(driveConfig?.clientId || "").trim();
    const apiKey = String(driveConfig?.apiKey || "").trim();
    if (!clientId || !apiKey) {
      setCalendarSyncStatus("Client ID / API Key를 먼저 입력하세요");
      return;
    }
    try {
      setCalendarSyncStatus("Google Calendar 연결 준비 중");
      const { gapi, google } = await loadGoogleClients();
      await new Promise((resolve, reject) => {
        gapi.load("client", { callback: resolve, onerror: () => reject(new Error("gapi load failed")) });
      });
      await gapi.client.init({ apiKey, discoveryDocs: [GOOGLE_API_DISCOVERY_DOC, GOOGLE_CALENDAR_DISCOVERY_DOC] });
      tokenClientRef.current = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: GOOGLE_COMBINED_SCOPE,
        callback: (resp) => {
          if (resp?.access_token) {
            setGoogleAccessToken(resp.access_token);
            setGoogleAuthReady(true);
            setGoogleCalendarReady(true);
            setCalendarSyncStatus("Google Calendar 연결됨");
            gapi.client.setToken({ access_token: resp.access_token });
          } else {
            setCalendarSyncStatus("Google Calendar 연결 실패");
          }
        },
      });
      tokenClientRef.current.requestAccessToken({ prompt: "consent" });
    } catch (error) {
      console.error(error);
      setCalendarSyncStatus("Google Calendar 연결 오류");
    }
  }

  async function exportSelectedDateToGoogleCalendar() {
    try {
      if (!window.gapi?.client || !googleCalendarReady) {
        setCalendarSyncStatus("먼저 Google Calendar 로그인 필요");
        return;
      }
      const items = expandedDateSchedules?.[selectedDate] || [];
      if (!items.length) {
        setCalendarSyncStatus("내보낼 일정 없음");
        return;
      }
      const year = currentMonth.getFullYear();
      const month = currentMonth.getMonth();
      for (const item of items) {
        const parsed = parseTimeRange(item.time);
        if (!parsed) continue;
        const sh = Math.floor(parsed.start);
        const sm = Math.round((parsed.start - sh) * 60);
        const eh = Math.floor(parsed.end);
        const em = Math.round((parsed.end - eh) * 60);
        const startAt = new Date(year, month, selectedDate, sh, sm);
        const endAt = new Date(year, month, selectedDate, eh, em);
        await window.gapi.client.calendar.events.insert({
          calendarId: "primary",
          resource: {
            summary: item.title || "일정",
            description: item.notes || "",
            start: { dateTime: startAt.toISOString() },
            end: { dateTime: endAt.toISOString() },
          },
        });
      }
      setCalendarSyncStatus("선택 날짜 일정 내보내기 완료");
    } catch (error) {
      console.error(error);
      setCalendarSyncStatus("Google Calendar 내보내기 실패");
    }
  }

  async function importSelectedDateFromGoogleCalendar() {
    try {
      if (!window.gapi?.client || !googleCalendarReady) {
        setCalendarSyncStatus("먼저 Google Calendar 로그인 필요");
        return;
      }
      const year = currentMonth.getFullYear();
      const month = currentMonth.getMonth();
      const startAt = new Date(year, month, selectedDate, 0, 0, 0, 0);
      const endAt = new Date(year, month, selectedDate, 23, 59, 59, 999);
      const response = await window.gapi.client.calendar.events.list({
        calendarId: "primary",
        timeMin: startAt.toISOString(),
        timeMax: endAt.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });
      const events = response.result.items || [];
      const imported = events
        .filter((event) => event.start?.dateTime && event.end?.dateTime)
        .map((event, idx) => {
          const startDate = new Date(event.start.dateTime);
          const endDate = new Date(event.end.dateTime);
          const time = `${String(startDate.getHours()).padStart(2, "0")}:${String(startDate.getMinutes()).padStart(2, "0")} - ${String(endDate.getHours()).padStart(2, "0")}:${String(endDate.getMinutes()).padStart(2, "0")}`;
          return {
            id: Date.now() + idx,
            title: event.summary || "Google 일정",
            time,
            color: "#60a5fa",
            repeat: "없음",
            repeatDays: [],
            notes: event.description || "",
            checklist: [],
            alerts: [],
            checked: false,
            repeatGroupId: null,
            occurrenceIndex: 0,
            baseDay: selectedDate,
          };
        });
      if (imported.length) {
        setDateSchedules((prev) => ({
          ...prev,
          [selectedDate]: [...(prev[selectedDate] || []), ...imported],
        }));
      }
      setCalendarSyncStatus(imported.length ? "선택 날짜 일정 가져오기 완료" : "가져올 일정 없음");
    } catch (error) {
      console.error(error);
      setCalendarSyncStatus("Google Calendar 가져오기 실패");
    }
  }

  async function connectDrivePlaceholder() {
    const clientId = String(driveConfig?.clientId || "").trim();
    const apiKey = String(driveConfig?.apiKey || "").trim();
    if (!clientId || !apiKey) {
      setSyncStatus("Client ID / API Key를 먼저 입력하세요");
      return;
    }
    try {
      setSyncStatus("Google API 로드 중");
      const { gapi, google } = await loadGoogleClients();
      await new Promise((resolve, reject) => {
        gapi.load("client", { callback: resolve, onerror: () => reject(new Error("gapi load failed")) });
      });
      await gapi.client.init({ apiKey, discoveryDocs: [GOOGLE_API_DISCOVERY_DOC] });
      tokenClientRef.current = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: GOOGLE_DRIVE_SCOPE,
        callback: (resp) => {
          if (resp?.access_token) {
            setGoogleAccessToken(resp.access_token);
            setGoogleAuthReady(true);
            const nextMeta = {
              connected: true,
              readyForOAuth: true,
              fileName: driveMeta?.fileName || "scheduler-sync.json",
              provider: "google-drive",
              connectedAt: nowIso(),
            };
            setDriveMeta(nextMeta);
            saveDriveMeta(nextMeta);
            setSyncStatus("Google Drive 로그인 완료");
          } else {
            setSyncStatus("Google 로그인 실패");
          }
        },
      });
      tokenClientRef.current.requestAccessToken({ prompt: "consent" });
    } catch {
      setSyncStatus("Google API 초기화 실패");
    }
  }

  async function manualDriveSync() {
    if (!googleAccessToken) {
      setSyncStatus("먼저 Drive 연결을 완료하세요");
      return;
    }
    try {
      setSyncStatus("Drive 파일 검색 중");
      const fileName = driveMeta?.fileName || "scheduler-sync.json";
      const q = encodeURIComponent(`name='${fileName.replace(/'/g, "\\'")}' and trashed=false`);
      const listResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=1`, {
        headers: { Authorization: `Bearer ${googleAccessToken}` },
      });
      const listJson = await listResp.json();
      const existingId = listJson?.files?.[0]?.id || "";
      const payload = buildPersistedPayload(getCurrentStateSnapshot());
      const metadata = { name: fileName, mimeType: "application/json" };
      const { boundary, body } = await createDriveMultipartBody(metadata, payload);
      const method = existingId ? "PATCH" : "POST";
      const url = existingId
        ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
        : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
      setSyncStatus(existingId ? "Drive 파일 업데이트 중" : "Drive 파일 생성 중");
      const uploadResp = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${googleAccessToken}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
      });
      const uploadJson = await uploadResp.json();
      if (!uploadResp.ok) throw new Error(uploadJson?.error?.message || "upload failed");
      const nextId = uploadJson?.id || existingId;
      if (nextId) setDriveFileId(nextId);
      const nextMeta = { ...(driveMeta || {}), connected: true, readyForOAuth: true, fileName, fileId: nextId };
      setDriveMeta(nextMeta);
      saveDriveMeta(nextMeta);
      setSyncStatus("Drive 동기화 완료");
    } catch {
      setSyncStatus("Drive 동기화 실패");
    }
  }

  async function downloadLatestDriveFile() {
    if (!googleAccessToken) {
      setSyncStatus("먼저 Drive 연결을 완료하세요");
      return;
    }
    try {
      setSyncStatus("Drive 파일 불러오는 중");
      let targetId = driveFileId || driveMeta?.fileId || "";
      if (!targetId) {
        const fileName = driveMeta?.fileName || "scheduler-sync.json";
        const q = encodeURIComponent(`name='${fileName.replace(/'/g, "\\'")}' and trashed=false`);
        const listResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=1`, {
          headers: { Authorization: `Bearer ${googleAccessToken}` },
        });
        const listJson = await listResp.json();
        targetId = listJson?.files?.[0]?.id || "";
      }
      if (!targetId) {
        setSyncStatus("Drive 파일을 찾지 못했습니다");
        return;
      }
      const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${targetId}?alt=media`, {
        headers: { Authorization: `Bearer ${googleAccessToken}` },
      });
      if (!resp.ok) throw new Error("download failed");
      const parsed = JSON.parse(await resp.text());
      if (!shouldApplyDrivePayload(parsed)) {
        setLastDriveCheckAt(nowIso());
        setSyncStatus("로컬 데이터가 더 최신입니다");
        return;
      }
      if (!applyIncomingDrivePayload(parsed)) throw new Error("invalid payload");
      setDriveFileId(targetId);
      setLastDriveCheckAt(nowIso());
      const nextMeta = { ...(driveMeta || {}), fileId: targetId };
      setDriveMeta(nextMeta);
      saveDriveMeta(nextMeta);
      setSyncStatus("Drive 불러오기 완료");
    } catch {
      setSyncStatus("Drive 불러오기 실패");
    }
  }

  function applyIncomingDrivePayload(parsed, options = {}) {
    const normalized = unwrapPersistedPayload(parsed);
    if (!normalized || Array.isArray(normalized)) return false;
    if (normalized.currentMonth) setCurrentMonth(new Date(normalized.currentMonth));
    if (parsed.updatedAt) setLastSavedAt(parsed.updatedAt);
    if (normalized.selectedDate) setSelectedDate(normalized.selectedDate);
    if (normalized.dateSchedules) setDateSchedules(Object.fromEntries(Object.entries(normalized.dateSchedules).map(([key, list]) => [key, (list || []).map((item) => ensureRepeatMeta(item, Number(key)))])));
    if (normalized.weekSchedules) setWeekSchedules(Object.fromEntries(Object.entries(normalized.weekSchedules).map(([key, list]) => [key, list || []])));
    if (normalized.scheduleViewMode) setScheduleViewMode(normalized.scheduleViewMode);
    if (normalized.selectedWeekdayKey) setSelectedWeekdayKey(normalized.selectedWeekdayKey);
    if ("selectedWeekScheduleId" in normalized) setSelectedWeekScheduleId(normalized.selectedWeekScheduleId);
    if (normalized.goals) setGoals(normalized.goals);
    if (normalized.todos) setTodos(normalized.todos);
    if (typeof normalized.todoMode === "boolean") setTodoMode(normalized.todoMode);
    if ("selectedDateScheduleId" in normalized) setSelectedDateScheduleId(normalized.selectedDateScheduleId);
    if ("selectedGoalId" in normalized) setSelectedGoalId(normalized.selectedGoalId);
    if ("selectedTodoId" in normalized) setSelectedTodoId(normalized.selectedTodoId);
    if (!options.silent) setSyncStatus("Drive 데이터 적용 완료");
    return true;
  }

  function shouldApplyDrivePayload(parsed) {
    const policy = driveConfig?.conflictPolicy || "newer-wins";
    const remoteUpdatedAt = parsed?.updatedAt ? new Date(parsed.updatedAt).getTime() : 0;
    const localUpdatedAt = lastSavedAt ? new Date(lastSavedAt).getTime() : 0;
    if (policy === "drive-first") return true;
    if (policy === "local-first") return remoteUpdatedAt > localUpdatedAt + 1000;
    return remoteUpdatedAt >= localUpdatedAt;
  }

  function importDriveExportFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!applyIncomingDrivePayload(parsed)) {
          alert("Drive 내보내기 형식이 아닙니다.");
        }
      } catch {
        alert("Drive 내보내기 파일을 읽을 수 없습니다.");
      }
    };
    reader.readAsText(file);
  }

  function disconnectDrivePlaceholder() {
    try {
      if (typeof window !== "undefined" && window.google?.accounts?.oauth2 && googleAccessToken) {
        window.google.accounts.oauth2.revoke(googleAccessToken, () => {});
      }
    } catch {
      // ignore revoke failures
    }
    setGoogleAccessToken("");
    setGoogleAuthReady(false);
    setDriveFileId("");
    const nextMeta = { connected: false, readyForOAuth: false, fileName: driveMeta?.fileName || "scheduler-sync.json", provider: "google-drive" };
    setDriveMeta(nextMeta);
    saveDriveMeta(nextMeta);
    setSyncStatus("Drive 연결 해제");
  }

  function updateDriveConfigField(key, value) {
    const nextConfig = { ...(driveConfig || {}), [key]: value };
    setDriveConfig(nextConfig);
    saveDriveConfig(nextConfig);
  }

  function restoreFromFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const normalized = unwrapPersistedPayload(parsed);
        if (Array.isArray(normalized)) {
          const imported = importScheduleItems(normalized);
          setDateSchedules((prev) => {
            const merged = { ...prev };
            Object.keys(imported.nextDateSchedules).forEach((key) => {
              merged[key] = (merged[key] || []).concat(imported.nextDateSchedules[key] || []);
            });
            return merged;
          });
          setImportSummary(imported.summary);
          return;
        }
        if (normalized.currentMonth) setCurrentMonth(new Date(normalized.currentMonth));
        if (parsed.updatedAt) setLastSavedAt(parsed.updatedAt);
        if (normalized.selectedDate) setSelectedDate(normalized.selectedDate);
        if (normalized.dateSchedules) setDateSchedules(Object.fromEntries(Object.entries(normalized.dateSchedules).map(([key, list]) => [key, (list || []).map((item) => ensureRepeatMeta(item, Number(key)))])));
        if (normalized.weekSchedules) setWeekSchedules(Object.fromEntries(Object.entries(normalized.weekSchedules).map(([key, list]) => [key, list || []])));
        if (normalized.scheduleViewMode) setScheduleViewMode(normalized.scheduleViewMode);
        if (normalized.selectedWeekdayKey) setSelectedWeekdayKey(normalized.selectedWeekdayKey);
        if ("selectedWeekScheduleId" in normalized) setSelectedWeekScheduleId(normalized.selectedWeekScheduleId);
        if (normalized.goals) setGoals(normalized.goals);
        if (normalized.todos) setTodos(normalized.todos);
        if (typeof normalized.todoMode === "boolean") setTodoMode(normalized.todoMode);
        if ("selectedDateScheduleId" in normalized) setSelectedDateScheduleId(normalized.selectedDateScheduleId);
        if ("selectedGoalId" in normalized) setSelectedGoalId(normalized.selectedGoalId);
        if ("selectedTodoId" in normalized) setSelectedTodoId(normalized.selectedTodoId);
      } catch {
        alert("JSON 복원에 실패했습니다.");
      }
    };
    reader.readAsText(file);
  }

  function confirmSecondaryDelete(optionKey) {
    const item = deleteState.item;
    if (!item) return;
    if (item.weekMode) {
      confirmDelete(optionKey);
      return;
    }
    if (safeGoals.some((entry) => entry.id === item.id)) {
      setGoals((prev) => prev.filter((entry) => entry.id !== item.id));
      if (selectedGoalId === item.id) setSelectedGoalId(null);
      setDeleteState({ open: false, item: null });
      return;
    }
    if (safeTodos.some((entry) => entry.id === item.id)) {
      setTodos((prev) => prev.filter((entry) => entry.id !== item.id));
      if (selectedTodoId === item.id) setSelectedTodoId(null);
      setDeleteState({ open: false, item: null });
      return;
    }
    confirmDelete(optionKey);
  }

  const scheduleHeaderRight = (
    <div className="flex items-center gap-3">
      {scheduleViewMode === "week" ? <WeekdaySelector mode="select" selectedDay={selectedWeekdayKey || "월"} onSelectDay={setSelectedWeekdayKey} value={[]} onToggle={() => {}} disabled={false} /> : null}
      <div className="flex rounded-[12px] border border-zinc-300 overflow-hidden">
        <button onClick={() => setScheduleViewMode("date")} className={cls("px-3 py-2 text-[11px] font-bold", scheduleViewMode === "date" ? "bg-zinc-900 text-white" : "bg-white text-zinc-600")}>날짜별</button>
        <button onClick={() => setScheduleViewMode("week")} className={cls("px-3 py-2 text-[11px] font-bold", scheduleViewMode === "week" ? "bg-zinc-900 text-white" : "bg-white text-zinc-600")}>요일별</button>
      </div>
    </div>
  );

  const alertPanelContent = (
    <div className="rounded-[24px] border border-zinc-300 bg-zinc-100 p-4">
      <div className="text-[18px] font-bold text-zinc-900 mb-3">알림</div>
      <div className="text-[12px] text-zinc-600">
        브라우저 알림 설정 영역
      </div>
    </div>
  );

const drivePanelContent = (
  <div className="rounded-[24px] border border-zinc-300 bg-zinc-100 p-4">
    <div className="text-[18px] font-bold text-zinc-900 mb-2">Google Drive 동기화</div>
    <div className="text-[12px] text-zinc-600">Drive 패널 준비중</div>
  </div>
);

  return (
    <>
      <DeleteDialog open={deleteState.open} item={deleteState.item} onClose={() => setDeleteState({ open: false, item: null })} onConfirm={confirmSecondaryDelete} />
      <RepeatApplyDialog open={repeatApplyState.open} item={repeatApplyState.item} patch={repeatApplyState.patch} onClose={() => setRepeatApplyState({ open: false, item: null, patch: null })} onConfirm={(scope) => { applyPatchByScope(repeatApplyState.item, repeatApplyState.patch, scope); setRepeatApplyState({ open: false, item: null, patch: null }); }} />

      <div className="min-h-screen w-full bg-zinc-50 px-2 py-2 md:px-3 md:py-3">
        <input ref={fileInputRef} type="file" accept="application/json" className="hidden" onChange={(e) => { restoreFromFile(e.target.files?.[0]); e.target.value = ""; }} />

        <div
          className={
            isMobileLayout
              ? "flex min-h-screen flex-col gap-2"
              : "grid min-h-screen grid-cols-[minmax(420px,52vw)_1fr] gap-3"
          }
        >
          <div
            className={
              isMobileLayout
                ? "flex w-full items-center justify-center overflow-hidden"
                : "sticky top-2 flex h-[calc(100vh-16px)] items-center justify-center overflow-hidden"
            }
          >
            <div
              style={{
                width: isMobileLayout ? `${viewportClockSize}px` : "min(52vw, 920px)",
                height: isMobileLayout ? `${viewportClockSize}px` : "min(52vw, 920px)",
              }}
              className="flex items-center justify-center"
            >
              <PolarClock
                selectedDate={selectedDate}
                selectedWeekday={selectedWeekday}
                dateItems={dateScheduleItems}
                weekItems={weekScheduleItems}
                currentTime={currentTime}
                selectedScheduleId={scheduleViewMode === "date" ? selectedDateScheduleId : selectedWeekScheduleId}
                selectedSchedule={selectedSchedule}
                onSelectDateSchedule={(id) => {
                  setSelectedDateScheduleId(id);
                  setScheduleViewMode("date");
                  setActiveList("schedule");
                }}
                onSelectWeekSchedule={(id) => {
                  setSelectedWeekScheduleId(id);
                  setScheduleViewMode("week");
                  setActiveList("schedule");
                }}
                monthLabel={currentMonth.getMonth() + 1}
                scheduleViewMode={scheduleViewMode}
                selectedWeekdayKey={selectedWeekdayKey}
                onDateMode={() => setScheduleViewMode("date")}
                onWeekMode={() => setScheduleViewMode("week")}
              />
            </div>
          </div>

          <div className={isMobileLayout ? "overflow-visible" : "h-[calc(100vh-16px)] overflow-y-auto pr-1"}>
            <div className={isMobileLayout ? "grid gap-2 pb-24" : "grid gap-2 pb-2"}>
              {safeImportSummary.length ? (
                <div className="rounded-[18px] border border-zinc-300 bg-white p-4 text-[clamp(11px,2.2vw,12px)] leading-6 text-zinc-700">
                  <div className="mb-2 text-[clamp(12px,2.5vw,14px)] font-extrabold text-zinc-900">생성된 반복 규칙 요약</div>
                  {safeImportSummary.map((line, idx) => (
                    <div key={idx}>• {line}</div>
                  ))}
                </div>
              ) : null}

              <CollapsiblePanel title="달력" open={openCalendarPanel} onToggle={() => setOpenCalendarPanel((v) => !v)}>
                <CalendarPanel
                  currentMonth={currentMonth}
                  setCurrentMonth={setCurrentMonth}
                  selectedDate={selectedDate}
                  setSelectedDate={setSelectedDate}
                  expandedDateSchedules={expandedDateSchedules}
                  todoMode={todoMode}
                  setTodoMode={setTodoMode}
                  onBackup={backupAll}
                  onRestoreClick={() => fileInputRef.current?.click()}
                />
              </CollapsiblePanel>

              {todoMode ? (
                <CollapsiblePanel title="TO-DO" open={openTodoPanel} onToggle={() => setOpenTodoPanel((v) => !v)}>
                  <SectionEditor
                    title="TO-DO"
                    items={todos}
                    selectedId={selectedTodo?.id ?? selectedTodoId}
                    setSelectedId={setSelectedTodoId}
                    onToggle={toggleTodo}
                    onUpdate={updateTodo}
                    onDelete={requestDeleteTodo}
                    listId="todo"
                    onKeyboardFocus={setActiveList}
                    onAdd={addTodo}
                  />
                </CollapsiblePanel>
              ) : (
                <>
                  <CollapsiblePanel title="일정" open={openSchedulePanel} onToggle={() => setOpenSchedulePanel((v) => !v)}>
                    <SectionEditor
                      title="일정"
                      items={scheduleItems}
                      selectedId={scheduleViewMode === "date" ? (selectedSchedule?.id ?? selectedDateScheduleId) : (selectedSchedule?.id ?? selectedWeekScheduleId)}
                      setSelectedId={scheduleViewMode === "date" ? setSelectedDateScheduleId : setSelectedWeekScheduleId}
                      onToggle={scheduleViewMode === "date" ? toggleDateItem : toggleWeekItem}
                      onUpdate={scheduleViewMode === "date" ? requestDateScheduleUpdate : requestWeekScheduleUpdate}
                      onDelete={scheduleViewMode === "date" ? requestDeleteDateItem : requestDeleteWeekItem}
                      showColor
                      showTime
                      showRepeat={scheduleViewMode === "date"}
                      listId="schedule"
                      onKeyboardFocus={setActiveList}
                      headerRight={scheduleHeaderRight}
                      onAdd={scheduleViewMode === "date" ? addDateItem : addWeekItem}
                    />
                  </CollapsiblePanel>

                  <CollapsiblePanel title="목표" open={openGoalPanel} onToggle={() => setOpenGoalPanel((v) => !v)}>
                    <SectionEditor
                      title="목표"
                      items={goals}
                      selectedId={selectedGoal?.id ?? selectedGoalId}
                      setSelectedId={setSelectedGoalId}
                      onToggle={toggleGoal}
                      onUpdate={updateGoal}
                      onDelete={requestDeleteGoal}
                      checkLast
                      listId="goal"
                      onKeyboardFocus={setActiveList}
                      onAdd={addGoal}
                    />
                  </CollapsiblePanel>

                  <CollapsiblePanel title="데이터 안정성 · 알림" open={openAlertPanel} onToggle={() => setOpenAlertPanel((v) => !v)}>
                    {alertPanelContent}
                  </CollapsiblePanel>

                  <CollapsiblePanel title="Drive 동기화" open={openDrivePanel} onToggle={() => setOpenDrivePanel((v) => !v)}>
                    {drivePanelContent}
                  </CollapsiblePanel>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

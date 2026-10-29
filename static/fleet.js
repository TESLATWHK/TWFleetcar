const HK = "Asia/Hong_Kong";
const PURPOSES = [
  ["test_drive", "Test drive"],
  ["customer_viewing", "Customer viewing"],
  ["display", "Display"],
  ["transfer", "Transfer"],
  ["service", "Service"],
  ["media", "Media / event"],
  ["internal", "Internal"],
  ["other", "Other"],
];
const ACTIONS = {
  checkout: "Checked out",
  checkin: "Checked in",
  move: "Moved",
};

const $ = (id) => document.getElementById(id);

let db = null;
let session = null;
let showrooms = [];
let cars = [];
let profiles = [];
let latestByCar = new Map();
let view = "calendar";
let roomViewId = "";
let actionCarId = null;
let actionName = "checkout";
let editingCarId = null;
let editingEventId = null;
let historyRows = [];
let logCarId = null;
let logRows = [];
let carShows = [];
let editingShowId = null;
let showEvents = [];
let showEventFor = "";
let calMonth = "";
let calDay = "";
let calEvents = [];
let calFormDay = "";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function banner(text, ok) {
  const el = $("banner");
  el.hidden = !text;
  el.textContent = text || "";
  el.className = ok ? "banner ok" : "banner";
}

function messageOf(error) {
  const text = (error && error.message) || "Something went wrong.";
  if (/schema cache|does not exist|permission denied|row-level security/i.test(text)) {
    return `${text} In Supabase, open the SQL Editor, run supabase/schema.sql again, then reload this page.`;
  }
  return text;
}

function purposeLabel(key) {
  return PURPOSES.find(([value]) => value === key)?.[1] || "";
}

function personName(id) {
  return profiles.find((person) => person.id === id)?.display_name || "Unknown";
}

function showroomName(id) {
  return showrooms.find((room) => room.id === id)?.name || "";
}

function kindLabel(kind) {
  return kind === "display" ? "Display" : "Demo";
}

function carById(id) {
  return cars.find((car) => car.id === id);
}

function hkYmd(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: HK,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function daysInMonth(ym) {
  const [year, month] = ym.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function shiftMonth(ym, delta) {
  const [year, month] = ym.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function ymdAdd(ymd, delta) {
  const date = new Date(`${ymd}T12:00:00+08:00`);
  date.setTime(date.getTime() + delta * 24 * 60 * 60 * 1000);
  return hkYmd(date);
}

function weekdayIndex(ymd) {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: HK,
    weekday: "short",
  }).format(new Date(`${ymd}T12:00:00+08:00`));
  return WEEKDAYS.indexOf(name);
}

function hkClock(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: HK,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

function fromHkClock(value) {
  return new Date(`${value}:00+08:00`).toISOString();
}

function formatTime(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-HK", {
    timeZone: HK,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function formatWhen(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-HK", {
    timeZone: HK,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function whereNow(car) {
  if (car.status === "out") {
    const bits = [];
    if (car.current_place) bits.push(car.current_place);
    const room = showroomName(car.current_showroom_id);
    if (room) bits.push(room);
    return bits.join(" · ") || "Out";
  }
  return showroomName(car.current_showroom_id) || car.current_place || "No showroom";
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => {
    if (value == null || value === false) return;
    if (key === "class") node.className = value;
    else node.setAttribute(key, value === true ? "" : value);
  });
  (children || []).forEach((child) => {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

function fillSelect(select, options, placeholder) {
  const current = select.value;
  select.replaceChildren();
  if (placeholder) select.append(new Option(placeholder.label, placeholder.value));
  options.forEach((option) => select.append(new Option(option.label, option.value)));
  const values = [...select.options].map((option) => option.value);
  if (values.includes(current)) select.value = current;
}

function roomOptions() {
  return showrooms.map((room) => ({ value: room.id, label: room.name }));
}

function setView(next) {
  view = next;
  ["calendar", "history", "log", "shows", "cars", "room"].forEach((name) => {
    const tab = $(`tab-${name}`);
    if (tab) tab.setAttribute("aria-selected", name === next ? "true" : "false");
    const panel = $(`view-${name}`);
    if (panel) panel.hidden = name !== next;
  });
  document.querySelectorAll("#room-tabs button").forEach((button) => {
    button.setAttribute("aria-selected", next === "room" && button.dataset.room === roomViewId ? "true" : "false");
  });
  if (next === "calendar") loadCalendar();
  if (next === "room") renderRoom();
  if (next === "history") searchHistory();
  if (next === "log") renderLog();
  if (next === "shows") renderShows();
  if (next === "cars") renderCars();
}

function renderRoomTabs() {
  const root = $("room-tabs");
  root.replaceChildren();
  showrooms.forEach((room) => {
    const button = el("button", {
      class: "btn",
      type: "button",
      role: "tab",
      "data-room": room.id,
      "aria-selected": view === "room" && roomViewId === room.id ? "true" : "false",
    }, [room.name]);
    button.addEventListener("click", () => {
      roomViewId = room.id;
      setView("room");
    });
    root.append(button);
  });
  if (!roomViewId && showrooms[0]) roomViewId = showrooms[0].id;
}

function renderRoom() {
  const room = showrooms.find((item) => item.id === roomViewId) || showrooms[0];
  const root = $("room-board");
  root.replaceChildren();
  if (!room) {
    root.append(el("p", { class: "empty" }, ["No showrooms yet."]));
    return;
  }
  roomViewId = room.id;
  const demos = cars
    .filter((car) => car.active && car.kind === "demo" && car.home_showroom_id === room.id)
    .slice()
    .sort((a, b) => a.nickname.localeCompare(b.nickname));
  root.append(el("div", { class: "group-head" }, [
    el("h2", null, [room.name]),
    el("span", { class: "count" }, [`${demos.length} demo`]),
  ]));
  const cards = el("div", { class: "cards" });
  if (!demos.length) cards.append(el("p", { class: "empty" }, ["No demo cars at this showroom."]));
  demos.forEach((car) => cards.append(carCard(car)));
  root.append(cards);
}

function carSummary(car) {
  return [
    car.model,
    car.exterior ? `Body ${car.exterior}` : "",
    car.interior ? `Interior ${car.interior}` : "",
    car.plate,
    car.vin,
  ].filter(Boolean);
}

function shortCar(car) {
  if (!car) return "Car";
  return [car.model || car.nickname, car.exterior].filter(Boolean).join(" ");
}

const PAINTS = [
  ["white", "#f4f1ea", "#d5cfc3"],
  ["silver", "#cfd3d8", "#9aa1a8"],
  ["glacier", "#8eb7c8", "#5e8ea3"],
  ["red", "#c41220", "#861018"],
  ["black", "#2a2c2f", "#101113"],
  ["grey", "#6e747b", "#4a5056"],
  ["gray", "#6e747b", "#4a5056"],
  ["blue", "#2c4f86", "#1b3358"],
];

function paintOf(name) {
  const key = String(name || "").trim().toLowerCase();
  const hit = PAINTS.find(([word]) => key.includes(word));
  return hit ? { body: hit[1], glass: hit[2] } : { body: "#d7d0c4", glass: "#a79f92" };
}

function photoFamily(model) {
  const key = String(model || "").toLowerCase().replace(/[-_]/g, " ");
  if (key.includes("model y l") || /\by l\b/.test(key)) return "myl";
  if (key.includes("model y") || /\by\b/.test(key)) return "my";
  if (key.includes("performance")) return "m3p";
  return "m3";
}

function photoColor(family, colorName) {
  const key = String(colorName || "").toLowerCase();
  let color = "grey";
  if (key.includes("glacier")) color = "glacier";
  else if (key.includes("white")) color = "white";
  else if (key.includes("silver")) color = "silver";
  else if (key.includes("red")) color = "red";
  else if (key.includes("black")) color = "black";
  else if (key.includes("grey") || key.includes("gray")) color = "grey";
  else if (key.includes("blue") && family.startsWith("my")) color = "glacier";
  if (family.startsWith("m3") && color === "glacier") color = "grey";
  if (family === "myl" && color === "silver") color = "grey";
  return color;
}

function carGraphic(colorName, model) {
  const family = photoFamily(model);
  const wrap = document.createElement("span");
  wrap.className = "car-swatch";
  wrap.title = [model, colorName].filter(Boolean).join(" · ") || "Tesla";
  const img = document.createElement("img");
  img.alt = "";
  img.src = `cars/${family}-${photoColor(family, colorName)}.jpg`;
  wrap.append(img);
  return wrap;
}

function paintDot(colorName) {
  const dot = document.createElement("span");
  dot.className = "paint-dot";
  dot.style.background = paintOf(colorName).body;
  return dot;
}

function showPaintPreview() {
  const name = $("car-exterior").value.trim();
  $("color-live").replaceChildren(
    carGraphic(name, $("car-model").value),
    document.createTextNode(name ? `Body ${name}` : "Type a body color"),
  );
}

function carCard(car) {
  const bits = carSummary(car);
  const atHome = car.status !== "out" && car.current_showroom_id === car.home_showroom_id && !car.current_place;
  const eyebrow = atHome ? kindLabel(car.kind) : whereNow(car);
  const detail = car.status === "out"
    ? `${personName(car.current_holder_id)} · ${purposeLabel(car.current_purpose) || "Out"} · since ${formatWhen(car.current_since)}`
    : `${purposeLabel(car.current_purpose) ? `${purposeLabel(car.current_purpose)} · ` : ""}since ${formatWhen(car.current_since) || "it was added"}`;
  const children = [
    el("span", { class: "kind" }, [eyebrow]),
    el("strong", null, [car.nickname]),
  ];
  if (bits.length) children.push(el("p", { class: "meta" }, [bits.join(" · ")]));
  children.push(el("p", { class: "meta" }, [detail]));
  const button = el("button", {
    class: car.status === "out" ? "card out" : "card",
    type: "button",
  }, [carGraphic(car.exterior, car.model), el("span", { class: "card-copy" }, children)]);
  button.addEventListener("click", () => openAction(car.id));
  return button;
}

function renderHistory() {
  const root = $("history");
  root.replaceChildren();
  if (!historyRows.length) {
    root.append(el("p", { class: "empty" }, ["Nothing matches."]));
    return;
  }
  const earlier = earlierByCar(historyRows);
  historyRows.forEach((row) => {
    const car = carById(row.car_id);
    const title = car ? car.nickname : "Retired car";
    const bits = [
      ACTIONS[row.action] || row.action,
      purposeLabel(row.purpose),
      car?.exterior ? `Body ${car.exterior}` : "",
      eventPlace(row),
      personName(row.actor_id),
      formatWhen(row.happened_at),
    ].filter(Boolean);
    const children = [
      el("strong", null, [title]),
      el("p", { class: "meta" }, [bits.join(" · ")]),
    ];
    const copy = el("span", { class: "card-copy" }, children);
    if (row.note) copy.append(el("p", { class: "preview" }, [row.note]));
    const button = el("button", { class: "card", type: "button" }, [
      carGraphic(car?.exterior, car?.model),
      copy,
      routePair(routeEnds(row, earlier.get(row.id), car)),
    ]);
    button.addEventListener("click", () => openHistoryEdit(row.id));
    root.append(button);
  });
  if (historyRows.length === 200) {
    root.append(el("p", { class: "hint" }, ["Showing the latest 200 matches. Narrow the dates to see older ones."]));
  }
}

function eventPlace(row) {
  const bits = [];
  const show = carShows.find((item) => item.id === row.car_show_id);
  if (show) bits.push(show.name);
  else if (row.place) bits.push(row.place);
  const room = showroomName(row.showroom_id);
  if (room) bits.push(room);
  return bits.join(" · ");
}

function renderCars() {
  fillSelect($("car-home"), roomOptions());
  renderShowroomEditors();
  const me = profiles.find((person) => person.id === session.user.id);
  if (me && document.activeElement !== $("my-name")) $("my-name").value = me.display_name;

  const root = $("car-list");
  root.replaceChildren();
  if (!cars.length) {
    root.append(el("p", { class: "empty" }, ["No cars yet."]));
    return;
  }
  cars.forEach((car) => {
    const bits = [kindLabel(car.kind), ...carSummary(car), showroomName(car.home_showroom_id)]
      .filter(Boolean);
    const button = el("button", {
      class: car.active ? "card" : "card retired",
      type: "button",
    }, [
      carGraphic(car.exterior, car.model),
      el("span", { class: "card-copy" }, [
        el("span", { class: "kind" }, [car.active ? "On the floor" : "Retired"]),
        el("strong", null, [car.nickname]),
        el("p", { class: "meta" }, [bits.join(" · ")]),
      ]),
    ]);
    button.addEventListener("click", () => editCar(car.id));
    const remove = el("button", { class: "btn warn", type: "button" }, ["Delete"]);
    remove.addEventListener("click", () => deleteCar(car.id));
    root.append(el("div", { class: "car-row" }, [button, remove]));
  });
}

function renderShowroomEditors() {
  const box = $("showroom-fields");
  if (box.contains(document.activeElement)) return;
  box.replaceChildren();
  showrooms.forEach((room, index) => {
    const input = el("input", { id: `room-${room.id}`, maxlength: "80", value: room.name, required: true });
    box.append(el("label", null, [`Showroom ${index + 1}`, input]));
  });
}

function fillFilters() {
  fillSelect(
    $("filter-car"),
    cars.map((car) => ({ value: car.id, label: car.nickname })),
    { value: "", label: "Any car" },
  );
  fillSelect(
    $("filter-who"),
    profiles.map((person) => ({ value: person.id, label: person.display_name })),
    { value: "", label: "Anyone" },
  );
  fillSelect(
    $("filter-purpose"),
    PURPOSES.map(([value, label]) => ({ value, label })),
    { value: "", label: "Any purpose" },
  );
  fillSelect($("filter-room"), roomOptions(), { value: "", label: "Any place" });
  const teammates = profiles.map((person) => ({ value: person.id, label: person.display_name }));
  fillSelect($("cal-who"), teammates);
  fillSelect($("action-who"), teammates);
  fillSelect($("history-actor"), teammates);
  ["cal-show", "action-show", "history-show"].forEach((id) => {
    fillSelect($(id), showChoices(), { value: "", label: "Not a car show" });
  });
  fillSelect(
    $("action-purpose"),
    PURPOSES.map(([value, label]) => ({ value, label })),
  );
}

function showApp(user) {
  const me = profiles.find((person) => person.id === user.id);
  document.body.classList.add("signed-in");
  $("signed-out").hidden = true;
  $("password").value = "";
  $("app").hidden = false;
  $("refresh").hidden = false;
  $("sign-out").hidden = false;
  $("who-pill").hidden = false;
  $("who-name").textContent = me?.display_name || user.email || "You";
  fillFilters();
  renderRoomTabs();
  if (view === "calendar") loadCalendar();
  if (view === "room") renderRoom();
  if (view === "cars") renderCars();
  if (view === "history") searchHistory();
  if (view === "log") renderLog();
  if (view === "shows") renderShows();
}

async function ensureProfile(user) {
  const { data, error } = await db.from("profiles").select("id, display_name, email").eq("id", user.id).maybeSingle();
  if (error) throw error;
  if (data) return;
  const displayName = String(user.user_metadata?.display_name || user.email?.split("@")[0] || "Teammate").trim();
  const inserted = await db.from("profiles").insert({
    id: user.id,
    display_name: displayName.slice(0, 80),
    email: user.email || null,
  });
  if (inserted.error) throw inserted.error;
}

async function applyDue() {
  const { error } = await db.rpc("apply_due_locations");
  if (!error) return;
  if (/schema cache|does not exist|could not find/i.test(error.message || "")) return;
  throw error;
}

async function loadFleet() {
  const [rooms, carRows, people, latest, showRows] = await Promise.all([
    db.from("showrooms").select("id, name, sort").order("sort"),
    db.from("cars").select("*").order("nickname"),
    db.from("profiles").select("id, display_name, email").order("display_name"),
    db.from("car_latest").select("id, car_id, actor_id, action, happened_at"),
    db.from("car_shows").select("id, name, venue, starts_on, ends_on, note, created_at").order("created_at", { ascending: false }),
  ]);
  const failed = [rooms, carRows, people].find((result) => result.error);
  if (failed) throw failed.error;
  showrooms = rooms.data || [];
  cars = carRows.data || [];
  profiles = people.data || [];
  latestByCar = new Map(latest.error ? [] : (latest.data || []).map((row) => [row.car_id, row]));
  if (showRows.error && !/schema cache|does not exist|could not find/i.test(showRows.error.message || "")) throw showRows.error;
  carShows = showRows.error ? [] : (showRows.data || []);
}

async function refresh(quiet) {
  if (!session) return false;
  try {
    if (!quiet) await applyDue();
    await loadFleet();
    showApp(session.user);
    if (!quiet) banner("", true);
    return true;
  } catch (error) {
    banner(messageOf(error));
    return false;
  }
}

async function searchHistory() {
  let query = db.from("events").select(
    "id, car_id, action, purpose, showroom_id, place, note, actor_id, happened_at, car_show_id",
  ).order("happened_at", { ascending: false }).limit(200);
  const carId = $("filter-car").value;
  const who = $("filter-who").value;
  const purpose = $("filter-purpose").value;
  const room = $("filter-room").value;
  const place = $("filter-place").value.trim().replace(/[%_]/g, "");
  const from = $("filter-from").value;
  const to = $("filter-to").value;
  if (carId) query = query.eq("car_id", carId);
  if (who) query = query.eq("actor_id", who);
  if (purpose) query = query.eq("purpose", purpose);
  if (room) query = query.eq("showroom_id", room);
  if (place) query = query.ilike("place", `%${place}%`);
  if (from) query = query.gte("happened_at", new Date(`${from}T00:00:00+08:00`).toISOString());
  if (to) {
    const end = new Date(`${to}T00:00:00+08:00`);
    end.setTime(end.getTime() + 24 * 60 * 60 * 1000);
    query = query.lt("happened_at", end.toISOString());
  }
  const { data, error } = await query;
  if (error) {
    banner(messageOf(error));
    return;
  }
  historyRows = data || [];
  renderHistory();
}

function syncHistoryPlace() {
  const name = $("history-action").value;
  const checkin = name === "checkin";
  $("history-place-label").hidden = checkin;
  $("history-show-label").hidden = checkin;
  $("history-room").required = checkin;
  if (checkin) $("history-show").value = "";
}

function eventById(id) {
  return historyRows.find((item) => item.id === id)
    || logRows.find((item) => item.id === id)
    || showEvents.find((item) => item.id === id);
}

function showChoices() {
  return carShows.map((show) => ({
    value: show.id,
    label: show.venue ? `${show.name} · ${show.venue}` : show.name,
  }));
}

function showWhen(show) {
  const fmt = (value) => {
    if (!value) return "";
    return new Intl.DateTimeFormat("en-HK", {
      timeZone: HK,
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(`${value}T12:00:00+08:00`));
  };
  const dates = [fmt(show.starts_on), fmt(show.ends_on)].filter(Boolean).join(" – ");
  return [show.venue, dates].filter(Boolean).join(" · ");
}

function pickedActivity(showId, roomId, place) {
  const show = carShows.find((item) => item.id === showId);
  if (roomId) return { showroomId: roomId, place: "", carShowId: null };
  if (show) return { showroomId: null, place: place || show.name, carShowId: show.id };
  return { showroomId: null, place, carShowId: null };
}

function clearShowIfRoom(roomId, showId, placeId) {
  if (!$(roomId).value) return;
  const show = carShows.find((item) => item.id === $(showId).value);
  $(showId).value = "";
  if (show && $(placeId).value.trim() === show.name) $(placeId).value = "";
}

function applyPickedShow(showSelect, roomSelect, placeInput, purposeSelect) {
  const show = carShows.find((item) => item.id === showSelect.value);
  if (!show) return;
  roomSelect.value = "";
  placeInput.value = show.name;
  if (purposeSelect) purposeSelect.value = "media";
}

function renderShows() {
  const list = $("show-list");
  list.replaceChildren();
  fillSelect($("show-pick"), showChoices(), { value: "", label: "Choose a car show" });
  if (!carShows.length) list.append(el("p", { class: "empty" }, ["No car shows yet."]));
  carShows.forEach((show) => {
    const button = el("button", {
      class: editingShowId === show.id ? "card out" : "card",
      type: "button",
    }, [
      el("span", { class: "card-copy" }, [
        el("strong", null, [show.name]),
        el("p", { class: "meta" }, [showWhen(show) || "No venue or dates yet"]),
      ]),
    ]);
    button.addEventListener("click", () => editShow(show.id));
    list.append(button);
  });
  if ($("show-pick").value) renderShowActivity();
  else {
    prepareShowEvent(null);
    $("show-detail").replaceChildren(el("p", { class: "empty" }, ["Choose a car show to see which cars went."]));
  }
}

function editShow(id) {
  const show = carShows.find((item) => item.id === id);
  if (!show) return;
  editingShowId = id;
  $("show-form-title").textContent = show.name;
  $("show-save").textContent = "Save changes";
  $("show-delete").hidden = false;
  $("show-name").value = show.name;
  $("show-venue").value = show.venue || "";
  $("show-start").value = show.starts_on || "";
  $("show-end").value = show.ends_on || "";
  $("show-note").value = show.note || "";
  $("show-pick").value = id;
  renderShows();
}

function prepareShowEvent(show) {
  const form = $("show-event-form");
  if (!show) {
    form.hidden = true;
    showEventFor = "";
    return;
  }
  form.hidden = false;
  const typing = form.contains(document.activeElement);
  fillSelect(
    $("show-event-car"),
    cars.filter((car) => car.active).map((car) => ({
      value: car.id,
      label: [car.nickname, car.exterior].filter(Boolean).join(" · "),
    })),
    { value: "", label: "Choose a car" },
  );
  fillSelect($("show-event-purpose"), PURPOSES.map(([value, label]) => ({ value, label })));
  fillSelect(
    $("show-event-who"),
    profiles.map((person) => ({ value: person.id, label: person.display_name })),
  );
  if (typing || showEventFor === show.id) return;
  showEventFor = show.id;
  $("show-event-action").value = "move";
  $("show-event-purpose").value = "media";
  $("show-event-who").value = session?.user?.id || "";
  $("show-event-time").value = hkClock(new Date());
  $("show-event-note").value = "";
  $("show-event-error").hidden = true;
}

async function saveShowEvent(event) {
  event.preventDefault();
  const show = carShows.find((item) => item.id === $("show-pick").value);
  const errorEl = $("show-event-error");
  if (!show) {
    errorEl.hidden = false;
    errorEl.textContent = "Choose a car show first.";
    return;
  }
  if (!$("show-event-car").value) {
    errorEl.hidden = false;
    errorEl.textContent = "Choose a car.";
    return;
  }
  const button = event.submitter;
  if (button) button.disabled = true;
  const { error } = await db.from("events").insert({
    car_id: $("show-event-car").value,
    action: $("show-event-action").value,
    purpose: $("show-event-purpose").value,
    showroom_id: null,
    place: show.name,
    car_show_id: show.id,
    note: $("show-event-note").value.trim(),
    actor_id: $("show-event-who").value,
    happened_at: fromHkClock($("show-event-time").value),
  });
  if (button) button.disabled = false;
  if (error) {
    errorEl.hidden = false;
    errorEl.textContent = messageOf(error);
    return;
  }
  errorEl.hidden = true;
  $("show-event-note").value = "";
  $("show-event-time").value = hkClock(new Date());
  const keep = show.id;
  if (!(await refresh(true))) return;
  editingShowId = keep;
  $("show-pick").value = keep;
  renderShows();
  banner("Record added to the car show.", true);
}

function clearShowForm() {
  editingShowId = null;
  $("show-form-title").textContent = "New car show";
  $("show-save").textContent = "Add car show";
  $("show-delete").hidden = true;
  $("show-form").reset();
}

async function renderShowActivity() {
  const id = $("show-pick").value;
  const root = $("show-detail");
  const show = carShows.find((item) => item.id === id);
  prepareShowEvent(show);
  root.replaceChildren();
  if (!show) {
    root.append(el("p", { class: "empty" }, ["Choose a car show to see which cars went."]));
    return;
  }
  const about = [showWhen(show), show.note].filter(Boolean).join(" · ");
  if (about) root.append(el("p", { class: "hint" }, [about]));
  root.append(el("p", { class: "empty" }, ["Loading..."]));
  const { data, error } = await db.from("events").select(
    "id, car_id, action, purpose, showroom_id, place, note, actor_id, happened_at, car_show_id",
  ).eq("car_show_id", id).order("happened_at", { ascending: false }).limit(200);
  if ($("show-pick").value !== id) return;
  root.replaceChildren();
  if (about) root.append(el("p", { class: "hint" }, [about]));
  if (error) {
    root.append(el("p", { class: "empty" }, [messageOf(error)]));
    return;
  }
  showEvents = data || [];
  if (!showEvents.length) {
    root.append(el("p", { class: "empty" }, ["No records for this show yet."]));
    return;
  }
  const byCar = new Map();
  showEvents.forEach((row) => {
    if (!byCar.has(row.car_id)) byCar.set(row.car_id, []);
    byCar.get(row.car_id).push(row);
  });
  byCar.forEach((rows, carId) => {
    const car = carById(carId);
    root.append(el("h3", { class: "log-month" }, [
      car ? car.nickname : "Retired car",
      el("span", null, [String(rows.length)]),
    ]));
    rows.forEach((row) => {
      const button = el("button", { class: "card", type: "button" }, [
        carGraphic(car?.exterior, car?.model),
        el("span", { class: "card-copy" }, [
          el("strong", null, [`${formatWhen(row.happened_at)} · ${ACTIONS[row.action] || row.action}`]),
          el("p", { class: "meta" }, [[
            purposeLabel(row.purpose),
            personName(row.actor_id),
            row.note,
          ].filter(Boolean).join(" · ")]),
        ]),
      ]);
      button.addEventListener("click", () => openHistoryEdit(row.id));
      root.append(button);
    });
  });
}

async function saveShow(event) {
  event.preventDefault();
  const payload = {
    name: $("show-name").value.trim(),
    venue: $("show-venue").value.trim(),
    starts_on: $("show-start").value || null,
    ends_on: $("show-end").value || null,
    note: $("show-note").value.trim(),
  };
  const wasNew = !editingShowId;
  const result = editingShowId
    ? await db.from("car_shows").update(payload).eq("id", editingShowId)
    : await db.from("car_shows").insert(payload).select("id").single();
  if (result.error) {
    banner(messageOf(result.error));
    return;
  }
  const savedId = editingShowId || result.data?.id;
  if (!(await refresh(true))) return;
  if (savedId) {
    editingShowId = savedId;
    $("show-pick").value = savedId;
    renderShows();
  }
  banner(wasNew ? "Car show added." : "Car show saved.", true);
}

async function deleteShow() {
  const show = carShows.find((item) => item.id === editingShowId);
  if (!show) return;
  if (!window.confirm(`Delete ${show.name}? Cars stay. Their records keep the place name.`)) return;
  const { error } = await db.from("car_shows").delete().eq("id", show.id);
  if (error) {
    banner(messageOf(error));
    return;
  }
  clearShowForm();
  $("show-pick").value = "";
  if (!(await refresh(true))) return;
  banner("Car show deleted.", true);
}

function openHistoryEdit(id) {
  const row = eventById(id);
  if (!row) return;
  editingEventId = id;
  const car = carById(row.car_id);
  $("history-edit-title").textContent = car ? car.nickname : "Edit record";
  fillSelect(
    $("history-car"),
    cars.map((item) => ({
      value: item.id,
      label: [item.nickname, item.exterior, item.active ? "" : "Retired"].filter(Boolean).join(" · "),
    })),
  );
  fillSelect($("history-purpose"), PURPOSES.map(([value, label]) => ({ value, label })));
  fillSelect($("history-room"), roomOptions(), { value: "", label: "Not a showroom" });
  $("history-car").value = row.car_id;
  $("history-action").value = row.action;
  $("history-purpose").value = row.purpose;
  $("history-actor").value = row.actor_id;
  $("history-room").value = row.showroom_id || "";
  $("history-show").value = row.car_show_id || "";
  $("history-place").value = row.place || "";
  $("history-note").value = row.note || "";
  $("history-time").value = hkClock(new Date(row.happened_at));
  $("history-error").hidden = true;
  syncHistoryPlace();
  $("history-dialog").showModal();
}

async function saveHistoryEdit(event) {
  event.preventDefault();
  if (!editingEventId) return;
  const name = $("history-action").value;
  const where = pickedActivity($("history-show").value, $("history-room").value || null, $("history-place").value.trim());
  const errorEl = $("history-error");
  if ((name === "checkout" || name === "move") && !where.showroomId && !where.place) {
    errorEl.hidden = false;
    errorEl.textContent = "Pick a showroom, or write the car show.";
    return;
  }
  if (name === "checkin" && !where.showroomId) {
    errorEl.hidden = false;
    errorEl.textContent = "Pick a showroom.";
    return;
  }
  const button = event.submitter;
  if (button) button.disabled = true;
  const { error } = await db.from("events").update({
    car_id: $("history-car").value,
    action: name,
    purpose: $("history-purpose").value,
    showroom_id: where.showroomId,
    place: where.place,
    car_show_id: where.carShowId,
    note: $("history-note").value.trim(),
    actor_id: $("history-actor").value,
    happened_at: fromHkClock($("history-time").value),
  }).eq("id", editingEventId);
  if (button) button.disabled = false;
  if (error) {
    errorEl.hidden = false;
    errorEl.textContent = messageOf(error);
    return;
  }
  $("history-dialog").close();
  editingEventId = null;
  if (!(await refresh(true))) return;
  banner("Record updated.", true);
}

function hkMonthLabel(ym) {
  return new Intl.DateTimeFormat("en-HK", {
    timeZone: HK,
    month: "long",
    year: "numeric",
  }).format(new Date(`${ym}-01T12:00:00+08:00`));
}

function renderLog() {
  if (logCarId && carById(logCarId)) {
    loadCarLog(logCarId);
    return;
  }
  logCarId = null;
  renderLogPicker();
}

function renderLogPicker() {
  $("log-detail").hidden = true;
  const root = $("log-cars");
  root.hidden = false;
  root.replaceChildren();
  if (!cars.length) {
    root.append(el("p", { class: "empty" }, ["No cars yet."]));
    return;
  }
  const placed = new Set();
  showrooms.forEach((room) => {
    const list = cars
      .filter((car) => car.home_showroom_id === room.id)
      .slice()
      .sort((a, b) => a.nickname.localeCompare(b.nickname));
    list.forEach((car) => placed.add(car.id));
    root.append(logGroup(room.name, list));
  });
  const rest = cars.filter((car) => !placed.has(car.id));
  if (rest.length) root.append(logGroup("Other", rest));
}

function logGroup(title, list) {
  const cards = el("div", { class: "cards" });
  if (!list.length) cards.append(el("p", { class: "empty" }, ["No cars."]));
  list.forEach((car) => cards.append(logCarButton(car)));
  return el("section", null, [
    el("div", { class: "group-head" }, [
      el("h2", null, [title]),
      el("span", { class: "count" }, [`${list.length}`]),
    ]),
    cards,
  ]);
}

function logCarButton(car) {
  const button = el("button", {
    class: car.active ? "card" : "card retired",
    type: "button",
  }, [
    carGraphic(car.exterior, car.model),
    el("span", { class: "card-copy" }, [
      el("span", { class: "kind" }, [car.active ? kindLabel(car.kind) : "Retired"]),
      el("strong", null, [car.nickname]),
      el("p", { class: "meta" }, [[...carSummary(car), showroomName(car.home_showroom_id)].filter(Boolean).join(" · ")]),
    ]),
  ]);
  button.addEventListener("click", () => loadCarLog(car.id));
  return button;
}

async function loadCarLog(carId) {
  logCarId = carId;
  $("log-cars").hidden = true;
  $("log-detail").hidden = false;
  const car = carById(carId);
  $("log-title").textContent = car ? car.nickname : "Log";
  const months = $("log-months");
  months.replaceChildren(el("p", { class: "empty" }, ["Loading..."]));
  const { data, error } = await db.from("events").select(
    "id, car_id, action, purpose, showroom_id, place, note, actor_id, happened_at, created_at, car_show_id",
  ).eq("car_id", carId).order("happened_at", { ascending: false }).limit(1000);
  if (logCarId !== carId) return;
  if (error) {
    months.replaceChildren(el("p", { class: "empty" }, [messageOf(error)]));
    return;
  }
  logRows = (data || []).slice().sort((a, b) => logTime(b, a));
  renderLogHead(car);
  renderLogMonths();
}

function logTime(a, b) {
  const time = new Date(a.happened_at) - new Date(b.happened_at);
  if (time) return time;
  const created = String(a.created_at || "").localeCompare(String(b.created_at || ""));
  if (created) return created;
  return String(a.id).localeCompare(String(b.id));
}

function earlierById(rows) {
  const ordered = rows.slice().sort(logTime);
  const map = new Map();
  ordered.forEach((row, index) => map.set(row.id, index ? ordered[index - 1] : null));
  return map;
}

function earlierByCar(rows) {
  const ordered = rows.slice().sort(logTime);
  const map = new Map();
  const last = new Map();
  ordered.forEach((row) => {
    map.set(row.id, last.get(row.car_id) || null);
    last.set(row.car_id, row);
  });
  return map;
}

function shortCode(label) {
  const text = String(label || "").trim();
  if (!text) return "—";
  if (/^[A-Za-z0-9]{1,4}$/.test(text)) return text.toUpperCase();
  const skip = new Set(["the", "a", "of", "at", "to", "and", "service", "center", "centre"]);
  const words = text.split(/[^A-Za-z0-9\u4e00-\u9fff]+/).filter((word) => word && !/\d/.test(word));
  const kept = words.filter((word) => !skip.has(word.toLowerCase()));
  const use = kept.length ? kept : words;
  if (!use.length) return text.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, "").slice(0, 4).toUpperCase() || "—";
  if (use.length === 1) return use[0].slice(0, 4).toUpperCase();
  return use.map((word) => word[0]).join("").toUpperCase().slice(0, 4);
}

function routePair(ends) {
  return el("span", { class: "route-pair", title: `${ends.from} → ${ends.to}` }, [
    el("span", { class: "route-badge" }, [shortCode(ends.from)]),
    routeArrow(),
    el("span", { class: "route-badge" }, [shortCode(ends.to)]),
  ]);
}

function stopName(row) {
  if (!row) return "";
  const show = carShows.find((item) => item.id === row.car_show_id);
  if (show) return show.name;
  if (row.place) return row.place;
  return showroomName(row.showroom_id) || "";
}

function routeEnds(row, earlier, car) {
  const from = earlier
    ? (stopName(earlier) || "Unknown")
    : (showroomName(car?.home_showroom_id) || "Home");
  let to = stopName(row);
  if (!to || (row.action === "checkout" && to === from)) to = row.action === "checkout" ? "Out" : (to || "—");
  return { from, to };
}

function routeArrow() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "route-arrow");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M12 3v16M5 13l7 8 7-8");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function routeBadge(row, earlier, car) {
  const { from, to } = routeEnds(row, earlier, car);
  const badge = el("span", { class: "route", title: `${from} to ${to}` }, [
    carGraphic(car?.exterior, car?.model),
    el("span", { class: "route-place" }, [from]),
    routeArrow(),
    el("span", { class: "route-place" }, [to]),
  ]);
  return badge;
}

function renderLogHead(car) {
  const head = $("log-head");
  head.replaceChildren();
  if (!car) return;
  const count = logRows.length;
  const latest = logRows[0];
  const earlier = earlierById(logRows);
  const children = [
    carGraphic(car.exterior, car.model),
    el("span", { class: "card-copy" }, [
      el("strong", null, [car.nickname]),
      el("p", { class: "meta" }, [[
        ...carSummary(car),
        showroomName(car.home_showroom_id),
        `${count} record${count === 1 ? "" : "s"}`,
      ].filter(Boolean).join(" · ")]),
    ]),
  ];
  if (latest) children.push(routeBadge(latest, earlier.get(latest.id), car));
  head.append(...children);
}

function renderLogMonths() {
  const root = $("log-months");
  root.replaceChildren();
  if (!logRows.length) {
    root.append(el("p", { class: "empty" }, ["No records for this car yet."]));
    return;
  }
  const earlier = earlierById(logRows);
  const car = carById(logCarId);
  const groups = new Map();
  logRows.forEach((row) => {
    const key = hkYmd(new Date(row.happened_at)).slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  groups.forEach((rows, key) => {
    root.append(el("h3", { class: "log-month" }, [
      hkMonthLabel(key),
      el("span", null, [String(rows.length)]),
    ]));
    rows.forEach((row) => root.append(logRecord(row, earlier.get(row.id), car)));
  });
  if (logRows.length === 1000) {
    root.append(el("p", { class: "hint" }, ["Showing the latest 1000 records."]));
  }
}

function logRecord(row, earlier, car) {
  const planned = new Date(row.happened_at).getTime() > Date.now();
  const bits = [
    planned ? "Planned" : "",
    purposeLabel(row.purpose),
    personName(row.actor_id),
  ].filter(Boolean);
  const copy = el("span", { class: "card-copy" }, [
    el("strong", null, [`${formatWhen(row.happened_at)} · ${ACTIONS[row.action] || row.action}`]),
    el("p", { class: "meta" }, [bits.join(" · ")]),
  ]);
  if (row.note) copy.append(el("p", { class: "preview" }, [row.note]));
  const button = el("button", { class: planned ? "card out" : "card", type: "button" }, [
    copy,
    routeBadge(row, earlier, car),
  ]);
  button.addEventListener("click", () => openHistoryEdit(row.id));
  return button;
}

async function deleteHistoryEdit() {
  const row = eventById(editingEventId);
  if (!row) return;
  const car = carById(row.car_id);
  const label = car ? car.nickname : "this record";
  if (!window.confirm(`Delete this log for ${label}?`)) return;
  $("history-delete").disabled = true;
  const { error } = await db.from("events").delete().eq("id", row.id);
  $("history-delete").disabled = false;
  if (error) {
    $("history-error").hidden = false;
    $("history-error").textContent = messageOf(error);
    return;
  }
  $("history-dialog").close();
  editingEventId = null;
  if (!(await refresh(true))) return;
  banner("Record deleted.", true);
}

function setAction(name) {
  actionName = name;
  [...$("action-picks").querySelectorAll("button")].forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.action === name ? "true" : "false");
  });
  const checkout = name === "checkout";
  const moving = name === "move";
  $("action-place-label").hidden = !(checkout || moving);
  $("action-show-label").hidden = !(checkout || moving);
  if (!(checkout || moving)) $("action-show").value = "";
  $("action-place").placeholder = moving ? "Car show name" : "Kowloon test drive";
  $("action-room").required = name === "checkin";
  fillSelect(
    $("action-room"),
    roomOptions(),
    { value: "", label: checkout ? "Not a showroom" : "Choose a showroom" },
  );
  if (name === "checkin") $("action-place").value = "";
  const car = carById(actionCarId);
  const purpose = $("action-purpose");
  if (name === "checkout") purpose.value = "test_drive";
  else if (name === "move") purpose.value = car?.kind === "display" ? "display" : "transfer";
  else purpose.value = "other";
  $("action-save").textContent = name === "checkout" ? "Check out" : name === "checkin" ? "Check in" : "Move";
}

function openAction(carId) {
  const car = carById(carId);
  if (!car) return;
  actionCarId = carId;
  $("action-title").textContent = car.nickname;
  $("action-kind").textContent = [
    kindLabel(car.kind),
    car.model,
    car.exterior ? `Body ${car.exterior}` : "",
    car.plate,
  ].filter(Boolean).join(" · ");
  $("action-meta").textContent = car.status === "out"
    ? `Out with ${personName(car.current_holder_id)} · ${whereNow(car)} · since ${formatWhen(car.current_since)}`
    : `In ${whereNow(car)}`;
  $("action-place").value = "";
  $("action-show").value = "";
  $("action-who").value = session.user.id;
  $("action-note").value = "";
  $("action-time").value = hkClock(new Date());
  $("action-error").hidden = true;
  const latest = latestByCar.get(carId);
  const mine = latest && latest.actor_id === session.user.id;
  $("action-undo").hidden = !mine;
  const roomId = car.status === "out" ? car.home_showroom_id : (car.current_showroom_id || car.home_showroom_id);
  setAction(car.status === "out" ? "checkin" : car.kind === "display" ? "move" : "checkout");
  if (roomId) $("action-room").value = roomId;
  $("action-dialog").showModal();
}

function clearCarForm() {
  editingCarId = null;
  $("car-form-title").textContent = "New car";
  $("car-save").textContent = "Add car";
  $("car-delete").hidden = true;
  $("car-form").reset();
  $("car-active").checked = true;
  if (showrooms[0]) $("car-home").value = showrooms[0].id;
  showPaintPreview();
}

function editCar(id) {
  const car = carById(id);
  if (!car) return;
  editingCarId = id;
  $("car-form-title").textContent = car.nickname;
  $("car-save").textContent = "Save changes";
  $("car-delete").hidden = false;
  $("car-name").value = car.nickname;
  $("car-model").value = car.model || "";
  $("car-exterior").value = car.exterior || "";
  $("car-interior").value = car.interior || "";
  $("car-plate").value = car.plate || "";
  $("car-vin").value = car.vin || "";
  $("car-kind").value = car.kind;
  $("car-home").value = car.home_showroom_id;
  $("car-notes").value = car.notes || "";
  $("car-active").checked = car.active;
  showPaintPreview();
}

function configProblem() {
  const cfg = window.FLEET_CONFIG || {};
  if (!cfg.url || !cfg.anonKey) return "Missing Fleet config.";
  if (
    String(cfg.url).includes("YOUR_PROJECT")
    || String(cfg.anonKey).includes("YOUR_ANON_KEY")
    || String(cfg.anonKey).includes("PASTE_THE_PUBLISHABLE_KEY")
  ) {
    return "Fleet config still has the placeholder key.";
  }
  return "";
}

let listening = false;

function watchRealtime() {
  if (listening) return;
  listening = true;
  db.channel("fleet")
    .on("postgres_changes", { event: "*", schema: "public", table: "cars" }, () => refresh(true))
    .on("postgres_changes", { event: "*", schema: "public", table: "events" }, () => refresh(true))
    .on("postgres_changes", { event: "*", schema: "public", table: "showrooms" }, () => refresh(true))
    .on("postgres_changes", { event: "*", schema: "public", table: "car_shows" }, () => refresh(true))
    .subscribe();
}

async function onSession(next) {
  session = next;
  if (!session) {
    document.body.classList.remove("signed-in");
    $("app").hidden = true;
    $("signed-out").hidden = false;
    $("refresh").hidden = true;
    $("sign-out").hidden = true;
    $("who-pill").hidden = true;
    return;
  }
  document.body.classList.add("signed-in");
  $("signed-out").hidden = true;
  try {
    await ensureProfile(session.user);
    await applyDue();
    await loadFleet();
    showApp(session.user);
    watchRealtime();
    banner("", true);
  } catch (error) {
    banner(messageOf(error));
  }
}

async function loadCalendar() {
  if (!calMonth) {
    calDay = hkYmd();
    calMonth = calDay.slice(0, 7);
  }
  if (!calDay.startsWith(calMonth)) calDay = `${calMonth}-01`;
  const first = `${calMonth}-01`;
  const pad = weekdayIndex(first);
  const count = daysInMonth(calMonth);
  const last = `${calMonth}-${String(count).padStart(2, "0")}`;
  const tail = (pad + count) % 7;
  const endPad = tail ? 7 - tail : 0;
  const start = new Date(`${ymdAdd(first, -pad)}T00:00:00+08:00`).toISOString();
  const end = new Date(`${ymdAdd(last, endPad + 1)}T00:00:00+08:00`).toISOString();
  const { data, error } = await db.from("events").select(
    "id, car_id, action, purpose, showroom_id, place, note, actor_id, happened_at, car_show_id",
  ).gte("happened_at", start).lt("happened_at", end).order("happened_at");
  if (error) {
    banner(messageOf(error));
    return;
  }
  calEvents = data || [];
  renderCalendar();
}

function renderCalendar() {
  $("cal-label").textContent = new Intl.DateTimeFormat("en-HK", {
    timeZone: HK,
    month: "long",
    year: "numeric",
  }).format(new Date(`${calMonth}-01T12:00:00+08:00`));
  const byDay = new Map();
  calEvents.forEach((row) => {
    const key = hkYmd(new Date(row.happened_at));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(row);
  });
  const grid = $("cal-grid");
  grid.replaceChildren();
  WEEKDAYS.forEach((name) => grid.append(el("div", { class: "cal-dow" }, [name])));
  const first = `${calMonth}-01`;
  const pad = weekdayIndex(first);
  const count = daysInMonth(calMonth);
  const today = hkYmd();
  for (let i = pad; i > 0; i -= 1) grid.append(dayCell(ymdAdd(first, -i), byDay, true, today));
  for (let day = 1; day <= count; day += 1) {
    grid.append(dayCell(`${calMonth}-${String(day).padStart(2, "0")}`, byDay, false, today));
  }
  const tail = (pad + count) % 7;
  if (tail) {
    const last = `${calMonth}-${String(count).padStart(2, "0")}`;
    for (let i = 1; i <= 7 - tail; i += 1) grid.append(dayCell(ymdAdd(last, i), byDay, true, today));
  }
  renderCalDay(byDay.get(calDay) || []);
}

function dayCell(ymd, byDay, outside, today) {
  const rows = byDay.get(ymd) || [];
  const classes = ["cal-day"];
  if (outside) classes.push("outside");
  if (ymd === today) classes.push("today");
  if (ymd === calDay) classes.push("selected");
  const chips = rows.slice(0, 2).map((row) => {
    const car = carById(row.car_id);
    return el("span", { class: "cal-chip" }, [
      paintDot(car?.exterior),
      `${formatTime(row.happened_at)} ${shortCar(car)}`,
    ]);
  });
  if (rows.length > 2) chips.push(el("span", { class: "cal-chip" }, [`+${rows.length - 2}`]));
  const button = el("button", { class: classes.join(" "), type: "button" }, [
    el("span", { class: "cal-num" }, [String(Number(ymd.slice(8)))]),
    ...chips,
  ]);
  button.addEventListener("click", () => {
    calDay = ymd;
    if (!ymd.startsWith(calMonth)) {
      calMonth = ymd.slice(0, 7);
      loadCalendar();
      return;
    }
    renderCalendar();
  });
  return button;
}

function renderCalDay(rows) {
  $("cal-day-title").textContent = new Intl.DateTimeFormat("en-HK", {
    timeZone: HK,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${calDay}T12:00:00+08:00`));
  const list = $("cal-day-list");
  list.replaceChildren();
  if (!rows.length) list.append(el("p", { class: "empty" }, ["Nothing recorded this day."]));
  rows.forEach((row) => {
    const car = carById(row.car_id);
    const planned = new Date(row.happened_at).getTime() > Date.now();
    const bits = [
      planned ? "Planned" : "",
      ACTIONS[row.action] || row.action,
      purposeLabel(row.purpose),
      car?.exterior ? `Body ${car.exterior}` : "",
      car?.interior ? `Interior ${car.interior}` : "",
      car?.plate || "",
      eventPlace(row),
      personName(row.actor_id),
      formatTime(row.happened_at),
    ].filter(Boolean);
    const children = [
      el("strong", null, [car ? car.nickname : "Retired car"]),
      el("p", { class: "meta" }, [bits.join(" · ")]),
    ];
    if (row.note) children.push(el("p", { class: "preview" }, [row.note]));
    list.append(el("article", { class: planned ? "card out" : "card" }, [
      carGraphic(car?.exterior, car?.model),
      el("span", { class: "card-copy" }, children),
    ]));
  });
  fillSelect(
    $("cal-car"),
    cars.filter((car) => car.active).map((car) => ({
      value: car.id,
      label: [car.nickname, car.exterior].filter(Boolean).join(" · "),
    })),
    { value: "", label: "Choose a car" },
  );
  fillSelect($("cal-purpose"), PURPOSES.map(([value, label]) => ({ value, label })));
  fillSelect($("cal-room"), roomOptions(), { value: "", label: "Not a showroom" });
  if (calFormDay !== calDay) {
    calFormDay = calDay;
    $("cal-action").value = "move";
    $("cal-purpose").value = "media";
    $("cal-time").value = calDay === hkYmd() ? hkClock(new Date()) : `${calDay}T10:00`;
    $("cal-place").value = "";
    $("cal-show").value = "";
    $("cal-who").value = session.user.id;
    $("cal-note").value = "";
    $("cal-error").hidden = true;
  }
  syncCalPlace();
}

function syncCalPlace() {
  const name = $("cal-action").value;
  const checkin = name === "checkin";
  $("cal-place-label").hidden = checkin;
  $("cal-show-label").hidden = checkin;
  $("cal-room").required = checkin;
  if (checkin) $("cal-show").value = "";
}

async function saveCalendar(event) {
  event.preventDefault();
  const name = $("cal-action").value;
  const where = pickedActivity($("cal-show").value, $("cal-room").value || null, $("cal-place").value.trim());
  const errorEl = $("cal-error");
  if ((name === "checkout" || name === "move") && !where.showroomId && !where.place) {
    errorEl.hidden = false;
    errorEl.textContent = "Pick a showroom, or write the car show.";
    return;
  }
  if (name === "checkin" && !where.showroomId) {
    errorEl.hidden = false;
    errorEl.textContent = "Pick a showroom.";
    return;
  }
  const button = event.submitter;
  if (button) button.disabled = true;
  const { error } = await db.from("events").insert({
    car_id: $("cal-car").value,
    action: name,
    purpose: $("cal-purpose").value,
    showroom_id: where.showroomId,
    place: where.place,
    car_show_id: where.carShowId,
    note: $("cal-note").value.trim(),
    actor_id: $("cal-who").value,
    happened_at: fromHkClock($("cal-time").value),
  });
  if (button) button.disabled = false;
  if (error) {
    errorEl.hidden = false;
    errorEl.textContent = messageOf(error);
    return;
  }
  errorEl.hidden = true;
  $("cal-place").value = "";
  $("cal-note").value = "";
  calFormDay = "";
  if (!(await refresh(true))) return;
  banner("Saved on the calendar.", true);
}

function bind() {
  $("sign-in").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    banner("");
    if (button) {
      button.disabled = true;
      button.textContent = "Signing in...";
    }
    const { data, error } = await db.auth.signInWithPassword({
      email: $("email").value.trim(),
      password: $("password").value,
    });
    if (button) {
      button.disabled = false;
      button.textContent = "Sign in";
    }
    if (error) {
      banner(messageOf(error));
      return;
    }
    await onSession(data.session);
  });
  $("sign-out").addEventListener("click", () => db.auth.signOut());
  $("refresh").addEventListener("click", () => refresh());
  $("tab-calendar").addEventListener("click", () => setView("calendar"));
  $("tab-history").addEventListener("click", () => setView("history"));
  $("tab-log").addEventListener("click", () => setView("log"));
  $("tab-shows").addEventListener("click", () => setView("shows"));
  $("show-form").addEventListener("submit", saveShow);
  $("show-clear").addEventListener("click", () => {
    clearShowForm();
    renderShows();
  });
  $("show-delete").addEventListener("click", deleteShow);
  $("show-pick").addEventListener("change", () => {
    editingShowId = $("show-pick").value || null;
    const show = carShows.find((item) => item.id === editingShowId);
    if (show) editShow(show.id);
    else {
      clearShowForm();
      renderShows();
    }
  });
  $("show-event-form").addEventListener("submit", saveShowEvent);
  $("log-back").addEventListener("click", () => {
    logCarId = null;
    logRows = [];
    renderLogPicker();
  });
  $("cal-prev").addEventListener("click", () => {
    calMonth = shiftMonth(calMonth || hkYmd().slice(0, 7), -1);
    loadCalendar();
  });
  $("cal-next").addEventListener("click", () => {
    calMonth = shiftMonth(calMonth || hkYmd().slice(0, 7), 1);
    loadCalendar();
  });
  $("cal-this").addEventListener("click", () => {
    calDay = hkYmd();
    calMonth = calDay.slice(0, 7);
    loadCalendar();
  });
  $("cal-action").addEventListener("change", () => {
    const name = $("cal-action").value;
    $("cal-purpose").value = name === "checkout" ? "test_drive" : name === "move" ? "media" : "other";
    syncCalPlace();
  });
  $("cal-show").addEventListener("change", () => {
    applyPickedShow($("cal-show"), $("cal-room"), $("cal-place"), $("cal-purpose"));
  });
  $("cal-room").addEventListener("change", () => clearShowIfRoom("cal-room", "cal-show", "cal-place"));
  $("action-show").addEventListener("change", () => {
    applyPickedShow($("action-show"), $("action-room"), $("action-place"), $("action-purpose"));
  });
  $("action-room").addEventListener("change", () => clearShowIfRoom("action-room", "action-show", "action-place"));
  $("history-show").addEventListener("change", () => {
    applyPickedShow($("history-show"), $("history-room"), $("history-place"), $("history-purpose"));
  });
  $("history-room").addEventListener("change", () => clearShowIfRoom("history-room", "history-show", "history-place"));
  $("cal-form").addEventListener("submit", saveCalendar);
  $("tab-cars").addEventListener("click", () => setView("cars"));
  $("history-form").addEventListener("submit", (event) => {
    event.preventDefault();
    searchHistory();
  });
  $("history-action").addEventListener("change", syncHistoryPlace);
  $("history-edit").addEventListener("submit", saveHistoryEdit);
  $("history-cancel").addEventListener("click", () => $("history-dialog").close());
  $("history-delete").addEventListener("click", deleteHistoryEdit);
  $("action-picks").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button) setAction(button.dataset.action);
  });
  $("action-cancel").addEventListener("click", () => $("action-dialog").close());
  $("action-form").addEventListener("submit", saveAction);
  $("action-undo").addEventListener("click", undoAction);
  $("car-form").addEventListener("submit", saveCar);
  $("car-new").addEventListener("click", clearCarForm);
  $("car-exterior").addEventListener("input", showPaintPreview);
  $("car-model").addEventListener("input", showPaintPreview);
  showPaintPreview();
  $("car-delete").addEventListener("click", () => {
    if (editingCarId) deleteCar(editingCarId);
  });
  $("room-form").addEventListener("submit", saveRooms);
  $("name-form").addEventListener("submit", saveName);
}

async function saveAction(event) {
  event.preventDefault();
  const car = carById(actionCarId);
  if (!car) return;
  const where = pickedActivity($("action-show").value, $("action-room").value || null, $("action-place").value.trim());
  if ((actionName === "checkout" || actionName === "move") && !where.showroomId && !where.place) {
    $("action-error").hidden = false;
    $("action-error").textContent = actionName === "move"
      ? "Pick a showroom, a car show, or write the place."
      : "Pick a showroom, a car show, or write the place.";
    return;
  }
  if (actionName === "checkin" && !where.showroomId) {
    $("action-error").hidden = false;
    $("action-error").textContent = "Pick a showroom.";
    return;
  }
  $("action-save").disabled = true;
  const { error } = await db.from("events").insert({
    car_id: car.id,
    action: actionName,
    purpose: $("action-purpose").value,
    showroom_id: where.showroomId,
    place: where.place,
    car_show_id: where.carShowId,
    note: $("action-note").value.trim(),
    actor_id: $("action-who").value,
    happened_at: fromHkClock($("action-time").value),
  });
  $("action-save").disabled = false;
  if (error) {
    $("action-error").hidden = false;
    $("action-error").textContent = messageOf(error);
    return;
  }
  $("action-dialog").close();
  await refresh();
}

async function undoAction() {
  const latest = latestByCar.get(actionCarId);
  if (!latest) return;
  $("action-undo").disabled = true;
  const { error } = await db.from("events").delete().eq("id", latest.id);
  $("action-undo").disabled = false;
  if (error) {
    $("action-error").hidden = false;
    $("action-error").textContent = messageOf(error);
    return;
  }
  $("action-dialog").close();
  await refresh();
}

async function saveCar(event) {
  event.preventDefault();
  const payload = {
    nickname: $("car-name").value.trim(),
    model: $("car-model").value.trim(),
    exterior: $("car-exterior").value.trim(),
    interior: $("car-interior").value.trim(),
    plate: $("car-plate").value.trim(),
    vin: $("car-vin").value.trim(),
    kind: $("car-kind").value,
    home_showroom_id: $("car-home").value,
    notes: $("car-notes").value.trim(),
    active: $("car-active").checked,
  };
  const result = editingCarId
    ? await db.from("cars").update(payload).eq("id", editingCarId)
    : await db.from("cars").insert(payload);
  if (result.error) {
    banner(messageOf(result.error));
    return;
  }
  const savedId = editingCarId;
  if (!(await refresh(true))) return;
  if (savedId) $("car-form-title").textContent = payload.nickname;
  else clearCarForm();
  banner(savedId ? "Car saved." : "Car added.", true);
}

async function deleteCar(id) {
  const car = carById(id);
  if (!car) return;
  if (!window.confirm(`Delete ${car.nickname}? Its calendar records are removed too.`)) return;
  const { error } = await db.rpc("delete_car", { p_car_id: id });
  if (error) {
    banner(messageOf(error));
    return;
  }
  if (editingCarId === id) clearCarForm();
  if (!(await refresh(true))) return;
  banner("Car deleted.", true);
}

async function saveRooms(event) {
  event.preventDefault();
  const names = showrooms.map((room) => ({
    id: room.id,
    name: $(`room-${room.id}`)?.value.trim() || "",
  }));
  for (const room of names) {
    const { error } = await db.from("showrooms").update({ name: room.name }).eq("id", room.id);
    if (error) {
      banner(messageOf(error));
      return;
    }
  }
  if (!(await refresh(true))) return;
  banner("Showroom names saved.", true);
}

async function saveName(event) {
  event.preventDefault();
  const { error } = await db.from("profiles").update({
    display_name: $("my-name").value.trim(),
  }).eq("id", session.user.id);
  if (error) {
    banner(messageOf(error));
    return;
  }
  if (!(await refresh(true))) return;
  banner("Name saved.", true);
}

async function boot() {
  bind();
  const problem = configProblem();
  if (problem) {
    banner(`${problem} Copy static/fleet-config.example.js to static/fleet-config.js and paste the Supabase URL and anon key. Run supabase/schema.sql first, and leave public sign-up off.`);
    return;
  }
  if (!window.supabase?.createClient) {
    banner("Could not load Supabase. Check the network and reload.");
    return;
  }
  db = window.supabase.createClient(window.FLEET_CONFIG.url, window.FLEET_CONFIG.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const { data, error } = await db.auth.getSession();
  if (error) {
    banner(messageOf(error));
    return;
  }
  await onSession(data?.session || null);
  db.auth.onAuthStateChange((event, next) => {
    if (event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") return;
    if (event === "SIGNED_IN" && session?.user?.id === next?.user?.id) return;
    setTimeout(() => onSession(next), 0);
  });
}

boot();

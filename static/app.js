(() => {
  "use strict";

  const STORAGE_KEY = "local-comic-reader.progress.v1";
  const HISTORY_KEY = "local-comic-reader.history.v1";
  const HISTORY_TOUCH_INTERVAL = 30 * 1000;
  const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 1000;
  const FOLDER_PICKER_TIMEOUT_MS = 125000;
  const ZOOM_MIN = 100;
  const ZOOM_MAX = 300;
  const ZOOM_STEP = 25;

  function readZoom() {
    const stored = Number(localStorage.getItem(`${STORAGE_KEY}.zoom`));
    return Number.isInteger(stored) && stored >= ZOOM_MIN && stored <= ZOOM_MAX && stored % ZOOM_STEP === 0
      ? stored
      : ZOOM_MIN;
  }

  const refs = {
    body: document.body,
    stage: document.getElementById("readerStage"),
    reader: document.getElementById("reader"),
    longCanvas: document.getElementById("longCanvas"),
    singleCanvas: document.getElementById("singleCanvas"),
    chapterEndNav: document.getElementById("chapterEndNav"),
    chapterEndPrevious: document.getElementById("chapterEndPrevious"),
    chapterEndNext: document.getElementById("chapterEndNext"),
    emptyState: document.getElementById("emptyState"),
    seriesHeading: document.getElementById("seriesHeading"),
    chapterHeading: document.getElementById("chapterHeading"),
    pageCounter: document.getElementById("pageCounter"),
    drawerLayer: document.getElementById("drawerLayer"),
    seriesList: document.getElementById("seriesList"),
    chapterList: document.getElementById("chapterList"),
    chapterCount: document.getElementById("chapterCount"),
    libraryToggle: document.getElementById("libraryToggle"),
    emptyOpenLibrary: document.getElementById("emptyOpenLibrary"),
    settingsToggle: document.querySelector('[data-action="open-settings"]'),
    settingsLayer: document.getElementById("settingsLayer"),
    settingsPath: document.getElementById("settingsPath"),
    settingsStatus: document.getElementById("settingsStatus"),
    settingsError: document.getElementById("settingsError"),
    settingsChoose: document.querySelector('[data-action="choose-library"]'),
    settingsReset: document.querySelector('[data-action="reset-library"]'),
    historyToggle: document.querySelector('[data-action="open-history"]'),
    historyLayer: document.getElementById("historyLayer"),
    historyList: document.getElementById("historyList"),
    historyCount: document.getElementById("historyCount"),
    zoomControl: document.getElementById("zoomControl"),
    zoomToggle: document.getElementById("zoomToggle"),
    zoomPanel: document.getElementById("zoomPanel"),
    zoomOut: document.getElementById("zoomOut"),
    zoomIn: document.getElementById("zoomIn"),
    zoomValue: document.getElementById("zoomValue"),
    messageLayer: document.getElementById("messageLayer"),
    messageTitle: document.getElementById("messageTitle"),
    messageBody: document.getElementById("messageBody"),
    messageRetry: document.getElementById("messageRetry"),
    messageDismiss: document.getElementById("messageDismiss"),
  };

  const state = {
    library: null,
    currentSeries: null,
    currentChapter: null,
    chapter: null,
    settings: null,
    libraryId: null,
    instanceId: null,
    mode: localStorage.getItem(`${STORAGE_KEY}.mode`) || "long",
    theme: localStorage.getItem(`${STORAGE_KEY}.theme`) || "dark",
    zoom: readZoom(),
    activeIndex: 0,
    restoringIndex: null,
    observer: null,
    drawerSeries: null,
    pendingChapterId: null,
    pendingChapterIndex: null,
    retryAction: null,
  };

  function progressStorageKey() {
    return state.libraryId ? `${STORAGE_KEY}.${state.libraryId}` : STORAGE_KEY;
  }

  function historyStorageKey() {
    return state.libraryId ? `${HISTORY_KEY}.${state.libraryId}` : HISTORY_KEY;
  }

  function readProgress() {
    try {
      return JSON.parse(localStorage.getItem(progressStorageKey()) || "{}");
    } catch {
      return {};
    }
  }

  function readHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(historyStorageKey()) || "{}");
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      return {
        version: 1,
        items: items.filter((item) => item && typeof item.chapterId === "string"),
      };
    } catch {
      return { version: 1, items: [] };
    }
  }

  function writeHistory(items) {
    localStorage.setItem(historyStorageKey(), JSON.stringify({ version: 1, items }));
  }

  function migrateScopedStorage(settings) {
    if (!settings?.libraryId) return;
    const scopedProgressKey = `${STORAGE_KEY}.${settings.libraryId}`;
    const scopedHistoryKey = `${HISTORY_KEY}.${settings.libraryId}`;
    if (settings.isDefault && !localStorage.getItem(scopedProgressKey)) {
      const legacyProgress = localStorage.getItem(STORAGE_KEY);
      if (legacyProgress) localStorage.setItem(scopedProgressKey, legacyProgress);
    }
    if (settings.isDefault && !localStorage.getItem(scopedHistoryKey)) {
      const legacyHistory = localStorage.getItem(HISTORY_KEY);
      if (legacyHistory) localStorage.setItem(scopedHistoryKey, legacyHistory);
    }
  }

  function chapterPageIndex(chapterId, pageCount) {
    const preferred = Number(readProgress()[chapterId]?.index);
    if (!Number.isFinite(preferred)) return 0;
    return pageCount > 0
      ? Math.max(0, Math.min(Math.floor(preferred), pageCount - 1))
      : Math.max(0, Math.floor(preferred));
  }

  function historySnapshot(found, fallback = {}) {
    const fallbackSeries = fallback.seriesName || fallback.chapterId?.split("/")[0] || "未知作品";
    const fallbackTitle = fallback.chapterTitle || fallback.chapterId?.split("/").pop() || "未知章节";
    return {
      chapterId: found?.item?.id || fallback.chapterId,
      seriesName: found?.series?.name || fallbackSeries,
      chapterTitle: found?.item?.title || fallbackTitle,
      pageCount: found?.item?.images || fallback.pageCount || 0,
      updatedAt: fallback.updatedAt ?? null,
    };
  }

  function migrateHistory() {
    const stored = localStorage.getItem(historyStorageKey());
    if (stored) {
      try {
        if (Array.isArray(JSON.parse(stored)?.items)) return;
      } catch {
        // Rebuild malformed history from the preserved page progress below.
      }
    }
    const progress = readProgress();
    const ids = Object.keys(progress).filter((id) => id !== "last" && progress[id] && typeof progress[id] === "object");
    const lastId = typeof progress.last?.chapter === "string" ? progress.last.chapter : null;
    const orderedIds = [
      ...(lastId && ids.includes(lastId) ? [lastId] : []),
      ...ids.filter((id) => id !== lastId).reverse(),
    ];
    const items = orderedIds.map((chapterId) => {
      const found = findChapter(chapterId);
      const saved = progress[chapterId] || {};
      return historySnapshot(found, {
        chapterId,
        pageCount: found?.item?.images || 0,
        updatedAt: null,
        seriesName: saved.seriesName,
        chapterTitle: saved.chapterTitle,
      });
    });
    writeHistory(items);
  }

  function touchHistory(force = false) {
    if (!state.currentChapter || !state.currentSeries) return;
    const history = readHistory();
    const previousIndex = history.items.findIndex((item) => item.chapterId === state.currentChapter.id);
    const previous = previousIndex >= 0 ? history.items[previousIndex] : null;
    const now = Date.now();
    const shouldRefreshTime = force || !previous?.updatedAt || now - previous.updatedAt >= HISTORY_TOUCH_INTERVAL;
    const next = historySnapshot({ series: state.currentSeries, item: state.currentChapter }, {
      updatedAt: shouldRefreshTime ? now : previous.updatedAt,
      pageCount: state.chapter?.images?.length || state.currentChapter.images || previous?.pageCount || 0,
    });
    history.items = [next, ...history.items.filter((item) => item.chapterId !== next.chapterId)];
    writeHistory(history.items);
  }

  function writeProgress() {
    if (!state.currentChapter) return;
    const progress = readProgress();
    progress[state.currentChapter.id] = { index: state.activeIndex, mode: state.mode };
    progress.last = { series: state.currentSeries.name, chapter: state.currentChapter.id };
    localStorage.setItem(progressStorageKey(), JSON.stringify(progress));
    touchHistory();
  }

  function showMessage(title, body, options = {}) {
    refs.messageTitle.textContent = title;
    refs.messageBody.textContent = body;
    state.retryAction = options.retry || null;
    refs.messageRetry.hidden = !state.retryAction;
    refs.messageDismiss.textContent = state.retryAction ? "关闭" : "知道了";
    refs.messageLayer.hidden = false;
  }

  function hideMessage() {
    refs.messageLayer.hidden = true;
    state.retryAction = null;
  }

  async function fetchJSON(url, options = {}) {
    const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...requestOptions } = options;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, { ...requestOptions, cache: "no-store", signal: controller.signal });
    } catch (error) {
      const unavailable = new Error("本地服务未运行");
      unavailable.code = error?.name === "AbortError" ? "SERVICE_TIMEOUT" : "SERVICE_UNAVAILABLE";
      throw unavailable;
    } finally {
      window.clearTimeout(timeout);
    }
    if (!response.ok) {
      let detail = "";
      try {
        const payload = await response.clone().json();
        detail = typeof payload?.error === "string" ? `：${payload.error}` : "";
      } catch {
        // Keep the HTTP status when the server did not return JSON.
      }
      const failure = new Error(`服务端返回 HTTP ${response.status}${detail}`);
      failure.code = "HTTP_ERROR";
      failure.status = response.status;
      throw failure;
    }
    try {
      return await response.json();
    } catch {
      const failure = new Error("服务端返回了无效数据");
      failure.code = "INVALID_RESPONSE";
      throw failure;
    }
  }

  function showServiceMessage(title, body, retry) {
    showMessage(title, body, { retry });
  }

  function setTheme(theme) {
    state.theme = theme === "light" ? "light" : "dark";
    refs.body.classList.toggle("theme-light", state.theme === "light");
    refs.body.classList.toggle("theme-dark", state.theme !== "light");
    localStorage.setItem(`${STORAGE_KEY}.theme`, state.theme);
  }

  function setZoomPanel(open) {
    refs.zoomPanel.hidden = !open;
    refs.zoomToggle.setAttribute("aria-expanded", String(open));
  }

  function captureZoomAnchor() {
    const stageRect = refs.stage.getBoundingClientRect();
    const image = state.mode === "single"
      ? refs.singleCanvas.querySelector("img")
      : refs.longCanvas.querySelector(`[data-page="${state.activeIndex}"]`);
    const imageRect = image?.getBoundingClientRect();
    const imageRatio = imageRect && imageRect.height > 0
      ? (stageRect.top + stageRect.height / 2 - imageRect.top) / imageRect.height
      : null;
    const scrollWidth = Math.max(refs.stage.scrollWidth, refs.stage.clientWidth);
    return {
      image,
      imageRatio,
      horizontalRatio: (refs.stage.scrollLeft + refs.stage.clientWidth / 2) / scrollWidth,
      verticalScroll: refs.stage.scrollTop,
    };
  }

  function restoreZoomAnchor(anchor) {
    if (!anchor) return;
    const stageRect = refs.stage.getBoundingClientRect();
    const imageRect = anchor.image?.isConnected ? anchor.image.getBoundingClientRect() : null;
    if (imageRect && anchor.imageRatio !== null && imageRect.height > 0) {
      const imagePoint = imageRect.top + imageRect.height * anchor.imageRatio;
      refs.stage.scrollTop += imagePoint - (stageRect.top + stageRect.height / 2);
    } else {
      refs.stage.scrollTop = anchor.verticalScroll;
    }
    refs.stage.scrollLeft = Math.max(
      0,
      anchor.horizontalRatio * Math.max(refs.stage.scrollWidth, refs.stage.clientWidth) - refs.stage.clientWidth / 2,
    );
  }

  function readerContentWidth() {
    const styles = getComputedStyle(refs.reader);
    const padding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
    return Math.max(0, refs.reader.clientWidth - padding);
  }

  function updateSingleZoomLayout() {
    const image = refs.singleCanvas.querySelector("img");
    if (!image || image.classList.contains("is-broken") || !image.naturalWidth || !image.naturalHeight) return;
    const canvasWidth = Math.min(920, readerContentWidth() || refs.stage.clientWidth);
    const maxHeight = Math.max(1, window.innerHeight - 120);
    const fit = Math.min(1, canvasWidth / image.naturalWidth, maxHeight / image.naturalHeight);
    const baseWidth = image.naturalWidth * fit;
    image.style.setProperty("--reader-base-width", `${baseWidth}px`);
    refs.singleCanvas.style.width = `${Math.max(canvasWidth, baseWidth * state.zoom / 100)}px`;
  }

  function applyZoom(preserveAnchor = false) {
    const anchor = preserveAnchor ? captureZoomAnchor() : null;
    refs.reader.style.setProperty("--reader-zoom", String(state.zoom / 100));
    refs.zoomValue.textContent = `${state.zoom}%`;
    refs.zoomOut.disabled = state.zoom <= ZOOM_MIN;
    refs.zoomIn.disabled = state.zoom >= ZOOM_MAX;
    refs.zoomToggle.classList.toggle("is-selected", state.zoom > ZOOM_MIN);
    refs.zoomToggle.setAttribute("aria-pressed", String(state.zoom > ZOOM_MIN));
    localStorage.setItem(`${STORAGE_KEY}.zoom`, String(state.zoom));
    if (state.mode === "single") updateSingleZoomLayout();
    if (anchor) requestAnimationFrame(() => restoreZoomAnchor(anchor));
  }

  function setZoom(value) {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(value / ZOOM_STEP) * ZOOM_STEP));
    if (next === state.zoom) return;
    state.zoom = next;
    applyZoom(true);
  }

  function setDrawer(open) {
    if (open) {
      refs.historyLayer.hidden = true;
      refs.historyToggle.classList.remove("is-selected");
      refs.historyToggle.setAttribute("aria-expanded", "false");
      setSettings(false);
    }
    refs.drawerLayer.hidden = !open;
    refs.libraryToggle.setAttribute("aria-expanded", String(open));
    if (open && state.library) {
      state.drawerSeries = state.currentSeries || state.drawerSeries || state.library.series[0];
      renderSeriesList();
      renderChapterList(state.drawerSeries);
    }
  }

  function historyTimeLabel(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "旧进度";
    const date = new Date(timestamp);
    const now = new Date();
    const elapsed = Math.max(0, now.getTime() - date.getTime());
    if (elapsed < 60 * 1000) return "刚刚";
    const sameDay = date.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay) return `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    if (date.toDateString() === yesterday.toDateString()) return `昨天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
      + ` ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }

  function historyRecords() {
    const progress = readProgress();
    return readHistory().items.map((record) => {
      const found = state.library ? findChapter(record.chapterId) : null;
      const pageCount = found?.item?.images || record.pageCount || 0;
      return {
        ...record,
        found,
        seriesName: found?.series?.name || (record.seriesName && record.seriesName !== "未知作品"
          ? record.seriesName
          : record.chapterId.split("/")[0] || "未知作品"),
        chapterTitle: found?.item?.title || (record.chapterTitle && record.chapterTitle !== "未知章节"
          ? record.chapterTitle
          : record.chapterId.split("/").pop() || "未知章节"),
        pageCount,
        pageIndex: chapterPageIndex(record.chapterId, pageCount),
        hasProgress: Boolean(progress[record.chapterId]),
      };
    });
  }

  function renderHistory() {
    // 章节文件被移走或删除后不再占用历史列表；原始记录保留在本地，
    // 以后文件补回并刷新页面时可以自动重新出现。
    const records = historyRecords().filter((record) => record.found);
    refs.historyCount.textContent = `${records.length}条`;
    refs.historyList.replaceChildren();
    if (!records.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "还没有阅读记录";
      refs.historyList.append(empty);
      return;
    }
    for (const record of records) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "history-item";
      button.classList.toggle("is-selected", state.currentChapter?.id === record.chapterId);
      button.innerHTML = `
        <span class="history-copy"><span class="history-series"></span><span class="history-chapter"></span></span>
        <span class="history-side"><span class="history-page"></span><span class="history-time"></span></span>`;
      button.querySelector(".history-series").textContent = record.seriesName;
      button.querySelector(".history-chapter").textContent = record.chapterTitle;
      button.querySelector(".history-page").textContent = record.pageCount
        ? `第${record.pageIndex + 1}/${record.pageCount}页`
        : `第${record.pageIndex + 1}页`;
      button.querySelector(".history-time").textContent = historyTimeLabel(record.updatedAt);
      button.addEventListener("click", () => {
        setHistory(false);
        selectChapter(record.chapterId, { initialIndex: record.pageIndex });
      });
      refs.historyList.append(button);
    }
  }

  function setHistory(open) {
    if (open) {
      setDrawer(false);
      setSettings(false);
      writeProgress();
      renderHistory();
    }
    refs.historyLayer.hidden = !open;
    refs.historyToggle.classList.toggle("is-selected", open);
    refs.historyToggle.setAttribute("aria-expanded", String(open));
  }

  function renderSettings(settings = state.settings) {
    if (!settings) {
      refs.settingsPath.textContent = "正在读取当前目录…";
      refs.settingsStatus.textContent = "读取中";
      refs.settingsStatus.classList.remove("is-error");
      refs.settingsReset.disabled = true;
      return;
    }
    refs.settingsPath.textContent = settings.libraryRoot || "未设置";
    refs.settingsStatus.textContent = !settings.available
      ? "目录不可用"
      : (!settings.hasImages ? "没有漫画图片" : "可用");
    refs.settingsStatus.classList.toggle("is-error", !settings.available || !settings.hasImages);
    refs.settingsReset.disabled = Boolean(settings.isDefault);
  }

  function setSettings(open) {
    if (open) {
      setDrawer(false);
      setHistory(false);
      setZoomPanel(false);
      refs.settingsError.hidden = true;
      refs.settingsError.textContent = "";
      renderSettings();
    }
    refs.settingsLayer.hidden = !open;
    refs.settingsToggle.setAttribute("aria-expanded", String(open));
  }

  function showSettingsError(message) {
    refs.settingsError.textContent = message;
    refs.settingsError.hidden = !message;
  }

  async function changeLibrary(action) {
    if (!state.instanceId || (action === "reset" && state.settings?.isDefault)) return;
    refs.settingsChoose.disabled = true;
    refs.settingsReset.disabled = true;
    showSettingsError("");
    refs.settingsStatus.textContent = action === "choose" ? "等待选择…" : "正在恢复…";
    refs.settingsStatus.classList.remove("is-error");
    try {
      writeProgress();
      const result = await fetchJSON("/api/settings/library", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Reader-Instance": state.instanceId,
        },
        body: JSON.stringify({ action }),
        timeoutMs: FOLDER_PICKER_TIMEOUT_MS,
      });
      if (result.cancelled) return;
      state.settings = result.settings;
      state.libraryId = state.settings.libraryId;
      migrateScopedStorage(state.settings);
      state.library = null;
      state.currentSeries = null;
      state.currentChapter = null;
      state.chapter = null;
      await loadLibrary({ openDrawer: true, forceDrawer: true });
      setSettings(false);
    } catch (error) {
      const message = error?.code === "SERVICE_UNAVAILABLE"
        ? "本地服务已停止，请重新启动阅读器。"
        : error?.code === "SERVICE_TIMEOUT"
          ? "文件夹选择等待超时，请重新选择。"
          : (error instanceof Error ? error.message : "目录切换失败，请稍后重试。");
      showSettingsError(message);
    } finally {
      renderSettings(state.settings);
      refs.settingsChoose.disabled = false;
      refs.settingsReset.disabled = Boolean(state.settings?.isDefault);
    }
  }

  function seriesImageCount(series) {
    return series.totalImages || 0;
  }

  function renderSeriesList() {
    refs.seriesList.replaceChildren();
    for (const series of state.library.series) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "series-item";
      button.classList.toggle("is-selected", state.drawerSeries?.name === series.name);
      button.innerHTML = `<span class="series-name"></span><span class="series-meta"></span>`;
      button.querySelector(".series-name").textContent = series.name;
      const pendingCount = (series.unindexed || []).length;
      button.querySelector(".series-meta").textContent = `${series.chapters.length}话 · ${seriesImageCount(series)}页${pendingCount ? ` · 待编序${pendingCount}` : ""}`;
      button.addEventListener("click", () => {
        state.drawerSeries = series;
        renderSeriesList();
        renderChapterList(series);
      });
      refs.seriesList.append(button);
    }
    const selected = refs.seriesList.querySelector(".series-item.is-selected");
    if (selected) selected.scrollIntoView({ block: "nearest" });
  }

  function chapterButton(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chapter-item";
    button.classList.toggle("is-selected", state.currentChapter?.id === item.id);
    button.innerHTML = `<span class="chapter-title"></span><span class="chapter-meta"></span>`;
    button.querySelector(".chapter-title").textContent = item.title;
    button.querySelector(".chapter-meta").textContent = `${item.images}页`;
    button.addEventListener("click", () => selectChapter(item.id));
    return button;
  }

  function renderChapterList(series) {
    refs.chapterList.replaceChildren();
    state.drawerSeries = series;
    const main = series.chapters || [];
    const appendix = series.appendix || [];
    const unindexed = series.unindexed || [];
    refs.chapterCount.textContent = `${main.length}话${appendix.length ? ` · 附录${appendix.length}` : ""}${unindexed.length ? ` · 待编序${unindexed.length}` : ""}`;
    if (main.length) {
      const mainLabel = document.createElement("div");
      mainLabel.className = "chapter-group-label";
      mainLabel.textContent = "阅读顺序 · 序章／正篇／特别篇";
      refs.chapterList.append(mainLabel);
      main.forEach((item) => refs.chapterList.append(chapterButton(item)));
    }
    if (appendix.length) {
      const appendixLabel = document.createElement("div");
      appendixLabel.className = "chapter-group-label";
      appendixLabel.textContent = "附录 · 非剧情材料";
      refs.chapterList.append(appendixLabel);
      appendix.forEach((item) => refs.chapterList.append(chapterButton(item)));
    }
    if (unindexed.length) {
      const pendingLabel = document.createElement("div");
      pendingLabel.className = "chapter-group-label";
      pendingLabel.textContent = "待编序 · 不参与上一话／下一话";
      refs.chapterList.append(pendingLabel);
      unindexed.forEach((item) => refs.chapterList.append(chapterButton(item)));
    }
  }

  function findChapter(id) {
    for (const series of state.library.series) {
      const all = [...series.chapters, ...series.appendix, ...(series.unindexed || [])];
      const index = all.findIndex((item) => item.id === id);
      if (index >= 0) return { series, all, index, item: all[index] };
    }
    return null;
  }

  function activeChapterList() {
    return state.currentChapter?.kind === "appendix" ? state.currentSeries.appendix : state.currentSeries.chapters;
  }

  function updateHeading() {
    refs.seriesHeading.textContent = state.currentSeries?.name || "请选择作品";
    refs.chapterHeading.textContent = state.currentChapter?.title || "打开目录开始阅读";
    document.title = state.currentSeries && state.currentChapter
      ? `${state.currentSeries.name} · ${state.currentChapter.title} | 本地漫画`
      : "本地漫画";
  }

  function updateModeButtons() {
    document.querySelector('[data-action="mode-long"]').classList.toggle("is-selected", state.mode === "long");
    document.querySelector('[data-action="mode-single"]').classList.toggle("is-selected", state.mode === "single");
  }

  function updateCounter() {
    const total = state.chapter?.images?.length || 0;
    refs.pageCounter.textContent = total ? `${String(state.activeIndex + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}` : "— / —";
  }

  function updateChapterEndNav() {
    const hasChapter = Boolean(state.currentChapter && state.currentSeries);
    refs.chapterEndNav.hidden = !hasChapter;
    if (!hasChapter) return;
    const list = activeChapterList();
    const index = list.findIndex((item) => item.id === state.currentChapter.id);
    refs.chapterEndPrevious.disabled = index <= 0;
    refs.chapterEndNext.disabled = index < 0 || index >= list.length - 1;
  }

  function imageElement(image, title) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.src = image.url;
    img.alt = `${title} · 第${image.page}页`;
    img.dataset.page = String(image.page - 1);
    img.addEventListener("error", () => {
      img.classList.add("is-broken");
      img.alt = `${image.name}（无法读取）`;
    });
    return img;
  }

  function disconnectObserver() {
    if (state.observer) state.observer.disconnect();
    state.observer = null;
  }

  function renderLong() {
    disconnectObserver();
    refs.longCanvas.replaceChildren();
    refs.singleCanvas.replaceChildren();
    const images = state.chapter?.images || [];
    const nodes = images.map((image) => imageElement(image, state.chapter.title));
    nodes.forEach((node) => refs.longCanvas.append(node));
    state.observer = new IntersectionObserver((entries) => {
      let best = null;
      for (const entry of entries) {
        if (!best || entry.intersectionRatio > best.intersectionRatio) best = entry;
      }
      if (state.restoringIndex !== null) return;
      if (best?.isIntersecting) {
        state.activeIndex = Number(best.target.dataset.page) || 0;
        updateCounter();
        writeProgress();
      }
    }, { root: refs.stage, threshold: [0.25, 0.55, 0.8] });
    nodes.forEach((node) => state.observer.observe(node));
    refs.longCanvas.classList.remove("hidden");
    refs.singleCanvas.classList.add("hidden");
    updateCounter();
  }

  function renderSingle() {
    disconnectObserver();
    refs.longCanvas.replaceChildren();
    refs.singleCanvas.replaceChildren();
    const image = state.chapter?.images?.[state.activeIndex];
    if (image) {
      const node = imageElement(image, state.chapter.title);
      node.addEventListener("load", updateSingleZoomLayout);
      refs.singleCanvas.append(node);
    }
    refs.longCanvas.classList.add("hidden");
    refs.singleCanvas.classList.remove("hidden");
    updateSingleZoomLayout();
    updateCounter();
  }

  function renderReader() {
    updateModeButtons();
    if (!state.currentChapter || !state.currentSeries) return;
    refs.emptyState.classList.add("hidden");
    refs.reader.classList.remove("hidden");
    updateHeading();
    if (state.mode === "single") renderSingle(); else renderLong();
    updateChapterEndNav();
    renderSeriesList();
    renderChapterList(state.drawerSeries || state.currentSeries);
  }

  function savedPosition(chapterId, length) {
    const saved = readProgress()[chapterId];
    const preferred = Number(saved?.index);
    return Number.isFinite(preferred) ? Math.max(0, Math.min(preferred, length - 1)) : 0;
  }

  function restoreScrollPosition() {
    if (state.mode !== "long" || state.activeIndex <= 0) {
      state.restoringIndex = null;
      return;
    }

    const chapterId = state.currentChapter?.id;
    const targetIndex = state.activeIndex;
    const nodes = [...refs.longCanvas.querySelectorAll("img")];
    const beforeTarget = nodes.slice(0, targetIndex + 1);
    state.restoringIndex = targetIndex;

    // 长卷使用懒加载。历史跳转时，目标页之前的图片若还没有尺寸，
    // scrollIntoView 会把目标误判在顶部；先让这些图片完成布局。
    beforeTarget.forEach((node) => {
      node.loading = "eager";
    });
    const pending = beforeTarget
      .filter((node) => !node.complete)
      .map((node) => new Promise((resolve) => {
        node.addEventListener("load", resolve, { once: true });
        node.addEventListener("error", resolve, { once: true });
      }));

    Promise.all(pending).then(() => {
      if (state.currentChapter?.id !== chapterId || state.activeIndex !== targetIndex) return;
      requestAnimationFrame(() => {
        const target = refs.longCanvas.querySelector(`[data-page="${targetIndex}"]`);
        target?.scrollIntoView({ block: "start" });
        requestAnimationFrame(() => {
          if (state.currentChapter?.id !== chapterId || state.activeIndex !== targetIndex) return;
          state.restoringIndex = null;
          updateCounter();
          writeProgress();
        });
      });
    });
  }

  async function selectChapter(chapterId, options = {}) {
    if (!state.library) return;
    const found = findChapter(chapterId);
    if (!found) return;
    state.pendingChapterId = chapterId;
    state.pendingChapterIndex = Number.isFinite(options.initialIndex) ? Math.max(0, Math.floor(options.initialIndex)) : null;
    refs.drawerLayer.hidden = true;
    refs.libraryToggle.setAttribute("aria-expanded", "false");
    setHistory(false);
    try {
      const chapter = await fetchJSON(`/api/chapter?chapter=${encodeURIComponent(chapterId)}`);
      state.currentSeries = found.series;
      state.drawerSeries = found.series;
      state.currentChapter = found.item;
      state.chapter = chapter;
      state.activeIndex = Number.isFinite(options.initialIndex)
        ? Math.max(0, Math.min(Math.floor(options.initialIndex), state.chapter.images.length - 1))
        : savedPosition(state.currentChapter.id, state.chapter.images.length);
      state.pendingChapterId = null;
      state.pendingChapterIndex = null;
      refs.stage.scrollTo({ top: 0, left: 0, behavior: "auto" });
      renderReader();
      restoreScrollPosition();
      writeProgress();
    } catch (error) {
      const isServiceError = error?.code === "SERVICE_UNAVAILABLE" || error?.code === "SERVICE_TIMEOUT";
      showMessage(
        isServiceError ? "本地服务已停止" : "无法读取章节",
        isServiceError
          ? "请重新双击“启动漫画阅读器.command”，服务恢复后点击“重新连接”。"
          : (error instanceof Error ? error.message : "请刷新后重试。"),
        { retry: isServiceError ? retryPending : null },
      );
    }
  }

  async function retryPending() {
    const pending = state.pendingChapterId;
    const pendingIndex = state.pendingChapterIndex;
    try {
      await loadLibrary();
      if (pending) {
        const found = findChapter(pending);
        if (found) {
          hideMessage();
          await selectChapter(pending, { initialIndex: pendingIndex });
          return;
        }
      }
      hideMessage();
      state.drawerSeries = state.currentSeries || state.library.series[0];
      setDrawer(true);
    } catch {
      showServiceMessage(
        "本地服务仍未连接",
        "请确认已双击“启动漫画阅读器.command”，然后再次点击“重新连接”。",
        retryPending,
      );
    }
  }

  async function loadLibrary(options = {}) {
    const shouldPreserveOpenSettings = () => !options.forceDrawer && !refs.settingsLayer.hidden;
    try {
      const health = await fetchJSON("/health");
      state.instanceId = health.instanceId;
      state.settings = await fetchJSON("/api/settings");
      state.libraryId = state.settings.libraryId || health.libraryId || null;
      migrateScopedStorage(state.settings);
      if (!refs.settingsLayer.hidden) renderSettings(state.settings);
      state.library = await fetchJSON("/api/library");
      if (!state.settings.available || !state.settings.hasImages || !state.library.series.length) {
        renderSettings(state.settings);
        setSettings(true);
        return;
      }
      migrateHistory();
      const progress = readProgress();
      const last = progress.last;
      const remembered = last?.chapter ? findChapter(last.chapter) : null;
      if (remembered) {
        state.drawerSeries = remembered.series;
        await selectChapter(remembered.item.id);
        if (options.openDrawer && !shouldPreserveOpenSettings()) setDrawer(true);
      } else {
        state.drawerSeries = state.library.series[0];
        renderSeriesList();
        renderChapterList(state.drawerSeries);
        if (!shouldPreserveOpenSettings()) setDrawer(true);
      }
    } catch (error) {
      const isServiceError = error?.code === "SERVICE_UNAVAILABLE" || error?.code === "SERVICE_TIMEOUT";
      showMessage(
        isServiceError ? "本地服务未运行" : "无法读取漫画目录",
        isServiceError
          ? "请双击“启动漫画阅读器.command”启动服务，然后点击“重新连接”。"
          : (error instanceof Error ? error.message : "请刷新后重试。"),
        { retry: isServiceError ? retryPending : null },
      );
    }
  }

  function moveChapter(delta) {
    if (!state.currentChapter || !state.currentSeries) return;
    const list = activeChapterList();
    const index = list.findIndex((item) => item.id === state.currentChapter.id);
    const next = list[index + delta];
    if (next) selectChapter(next.id);
  }

  function movePage(delta) {
    if (state.mode !== "single" || !state.chapter) return;
    const nextIndex = Math.max(0, Math.min(state.chapter.images.length - 1, state.activeIndex + delta));
    if (nextIndex === state.activeIndex) return;
    state.activeIndex = nextIndex;
    renderSingle();
    writeProgress();
  }

  function scrollToChapterStart() {
    if (!state.chapter) {
      refs.stage.scrollTo({ top: 0, left: 0, behavior: "smooth" });
      return;
    }
    state.activeIndex = 0;
    if (state.mode === "single") renderSingle();
    else updateCounter();
    writeProgress();
    refs.stage.scrollTo({ top: 0, left: 0, behavior: "smooth" });
  }

  function handleAction(action) {
    if (action === "open-library") setDrawer(true);
    if (action === "close-library") setDrawer(false);
    if (action === "open-settings") setSettings(true);
    if (action === "close-settings") setSettings(false);
    if (action === "choose-library") changeLibrary("choose");
    if (action === "reset-library") changeLibrary("reset");
    if (action === "open-history") setHistory(true);
    if (action === "close-history") setHistory(false);
    if (action === "toggle-theme") setTheme(state.theme === "dark" ? "light" : "dark");
    if (action === "toggle-zoom") setZoomPanel(refs.zoomPanel.hidden);
    if (action === "zoom-in") setZoom(state.zoom + ZOOM_STEP);
    if (action === "zoom-out") setZoom(state.zoom - ZOOM_STEP);
    if (action === "zoom-reset") setZoom(ZOOM_MIN);
    if (action === "mode-long") { state.mode = "long"; localStorage.setItem(`${STORAGE_KEY}.mode`, state.mode); renderReader(); writeProgress(); }
    if (action === "mode-single") { state.mode = "single"; localStorage.setItem(`${STORAGE_KEY}.mode`, state.mode); renderReader(); writeProgress(); }
    if (action === "previous-chapter") moveChapter(-1);
    if (action === "next-chapter") moveChapter(1);
    if (action === "scroll-top") scrollToChapterStart();
  }

  document.addEventListener("click", (event) => {
    if (!event.target.closest("#zoomControl")) setZoomPanel(false);
    const target = event.target.closest("[data-action]");
    if (target) handleAction(target.dataset.action);
  });
  document.querySelector("#settingsLayer .settings-backdrop")?.addEventListener("click", () => setSettings(false));
  refs.libraryToggle.addEventListener("click", () => setDrawer(true));
  refs.emptyOpenLibrary.addEventListener("click", () => setDrawer(true));
  refs.messageRetry.addEventListener("click", async () => {
    const retry = state.retryAction;
    if (!retry) return;
    refs.messageRetry.disabled = true;
    try {
      await retry();
    } finally {
      refs.messageRetry.disabled = false;
    }
  });
  refs.messageDismiss.addEventListener("click", hideMessage);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !refs.zoomPanel.hidden) {
      setZoomPanel(false);
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" && !refs.drawerLayer.hidden) setDrawer(false);
    if (event.key === "Escape" && !refs.historyLayer.hidden) setHistory(false);
    if (event.key === "Escape" && !refs.settingsLayer.hidden) setSettings(false);
    if (event.key === "ArrowLeft") movePage(-1);
    if (event.key === "ArrowRight") movePage(1);
    if (event.key === "PageUp") { event.preventDefault(); refs.stage.scrollBy({ top: -refs.stage.clientHeight * .85, behavior: "smooth" }); }
    if (event.key === "PageDown") { event.preventDefault(); refs.stage.scrollBy({ top: refs.stage.clientHeight * .85, behavior: "smooth" }); }
  });
  window.addEventListener("resize", () => {
    if (state.mode === "single") updateSingleZoomLayout();
  });
  window.addEventListener("pagehide", () => writeProgress());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") writeProgress();
  });

  setTheme(state.theme);
  applyZoom();
  loadLibrary();
})();

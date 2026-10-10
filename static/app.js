(() => {
  "use strict";

  const STORAGE_KEY = "local-comic-reader.progress.v1";
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
    mode: localStorage.getItem(`${STORAGE_KEY}.mode`) || "long",
    theme: localStorage.getItem(`${STORAGE_KEY}.theme`) || "dark",
    zoom: readZoom(),
    activeIndex: 0,
    observer: null,
    drawerSeries: null,
    pendingChapterId: null,
    retryAction: null,
  };

  function readProgress() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function writeProgress() {
    if (!state.currentChapter) return;
    const progress = readProgress();
    progress[state.currentChapter.id] = { index: state.activeIndex, mode: state.mode };
    progress.last = { series: state.currentSeries.name, chapter: state.currentChapter.id };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
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

  async function fetchJSON(url) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    let response;
    try {
      response = await fetch(url, { cache: "no-store", signal: controller.signal });
    } catch (error) {
      const unavailable = new Error("本地服务未运行");
      unavailable.code = error?.name === "AbortError" ? "SERVICE_TIMEOUT" : "SERVICE_UNAVAILABLE";
      throw unavailable;
    } finally {
      window.clearTimeout(timeout);
    }
    if (!response.ok) {
      const failure = new Error(`服务端返回 HTTP ${response.status}`);
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
    refs.drawerLayer.hidden = !open;
    refs.libraryToggle.setAttribute("aria-expanded", String(open));
    if (open && state.library) {
      state.drawerSeries = state.currentSeries || state.drawerSeries || state.library.series[0];
      renderSeriesList();
      renderChapterList(state.drawerSeries);
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
    if (state.mode === "long" && state.activeIndex > 0) {
      requestAnimationFrame(() => {
        const target = refs.longCanvas.querySelector(`[data-page="${state.activeIndex}"]`);
        target?.scrollIntoView({ block: "start" });
        updateCounter();
      });
    }
  }

  async function selectChapter(chapterId) {
    if (!state.library) return;
    const found = findChapter(chapterId);
    if (!found) return;
    state.pendingChapterId = chapterId;
    refs.drawerLayer.hidden = true;
    refs.libraryToggle.setAttribute("aria-expanded", "false");
    try {
      const chapter = await fetchJSON(`/api/chapter?chapter=${encodeURIComponent(chapterId)}`);
      state.currentSeries = found.series;
      state.drawerSeries = found.series;
      state.currentChapter = found.item;
      state.chapter = chapter;
      state.activeIndex = savedPosition(state.currentChapter.id, state.chapter.images.length);
      state.pendingChapterId = null;
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
    try {
      state.library = await fetchJSON("/api/library");
      if (pending) {
        const found = findChapter(pending);
        if (found) {
          hideMessage();
          await selectChapter(pending);
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

  async function loadLibrary() {
    try {
      state.library = await fetchJSON("/api/library");
      if (!state.library.series.length) {
        showMessage("没有发现漫画", "请确认漫画目录位于本工具的上一级目录，并且章节文件夹内有图片。");
        return;
      }
      const progress = readProgress();
      const last = progress.last;
      const remembered = last?.chapter ? findChapter(last.chapter) : null;
      if (remembered) {
        state.drawerSeries = remembered.series;
        await selectChapter(remembered.item.id);
      } else {
        state.drawerSeries = state.library.series[0];
        renderSeriesList();
        renderChapterList(state.drawerSeries);
        setDrawer(true);
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

  function handleAction(action) {
    if (action === "open-library") setDrawer(true);
    if (action === "close-library") setDrawer(false);
    if (action === "toggle-theme") setTheme(state.theme === "dark" ? "light" : "dark");
    if (action === "toggle-zoom") setZoomPanel(refs.zoomPanel.hidden);
    if (action === "zoom-in") setZoom(state.zoom + ZOOM_STEP);
    if (action === "zoom-out") setZoom(state.zoom - ZOOM_STEP);
    if (action === "zoom-reset") setZoom(ZOOM_MIN);
    if (action === "mode-long") { state.mode = "long"; localStorage.setItem(`${STORAGE_KEY}.mode`, state.mode); renderReader(); }
    if (action === "mode-single") { state.mode = "single"; localStorage.setItem(`${STORAGE_KEY}.mode`, state.mode); renderReader(); }
    if (action === "previous-chapter") moveChapter(-1);
    if (action === "next-chapter") moveChapter(1);
  }

  document.addEventListener("click", (event) => {
    if (!event.target.closest("#zoomControl")) setZoomPanel(false);
    const target = event.target.closest("[data-action]");
    if (target) handleAction(target.dataset.action);
  });
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
    if (event.key === "ArrowLeft") movePage(-1);
    if (event.key === "ArrowRight") movePage(1);
    if (event.key === "PageUp") { event.preventDefault(); refs.stage.scrollBy({ top: -refs.stage.clientHeight * .85, behavior: "smooth" }); }
    if (event.key === "PageDown") { event.preventDefault(); refs.stage.scrollBy({ top: refs.stage.clientHeight * .85, behavior: "smooth" }); }
  });
  window.addEventListener("resize", () => {
    if (state.mode === "single") updateSingleZoomLayout();
  });

  setTheme(state.theme);
  applyZoom();
  loadLibrary();
})();

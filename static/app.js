(() => {
  "use strict";

  const STORAGE_KEY = "local-comic-reader.progress.v1";
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
    messageLayer: document.getElementById("messageLayer"),
    messageTitle: document.getElementById("messageTitle"),
    messageBody: document.getElementById("messageBody"),
    messageDismiss: document.getElementById("messageDismiss"),
  };

  const state = {
    library: null,
    currentSeries: null,
    currentChapter: null,
    chapter: null,
    mode: localStorage.getItem(`${STORAGE_KEY}.mode`) || "long",
    theme: localStorage.getItem(`${STORAGE_KEY}.theme`) || "dark",
    activeIndex: 0,
    observer: null,
    drawerSeries: null,
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

  function showMessage(title, body) {
    refs.messageTitle.textContent = title;
    refs.messageBody.textContent = body;
    refs.messageLayer.hidden = false;
  }

  function hideMessage() { refs.messageLayer.hidden = true; }

  function setTheme(theme) {
    state.theme = theme === "light" ? "light" : "dark";
    refs.body.classList.toggle("theme-light", state.theme === "light");
    refs.body.classList.toggle("theme-dark", state.theme !== "light");
    localStorage.setItem(`${STORAGE_KEY}.theme`, state.theme);
  }

  function setDrawer(open) {
    refs.drawerLayer.hidden = !open;
    refs.libraryToggle.setAttribute("aria-expanded", String(open));
    if (open && state.library) {
      renderSeriesList();
      renderChapterList(state.drawerSeries || state.currentSeries || state.library.series[0]);
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
      button.querySelector(".series-meta").textContent = `${series.chapters.length}话 · ${seriesImageCount(series)}页`;
      button.addEventListener("click", () => {
        state.drawerSeries = series;
        renderSeriesList();
        renderChapterList(series);
      });
      refs.seriesList.append(button);
    }
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
    refs.chapterCount.textContent = `${main.length}话${appendix.length ? ` · 附录${appendix.length}` : ""}`;
    if (main.length) {
      const mainLabel = document.createElement("div");
      mainLabel.className = "chapter-group-label";
      mainLabel.textContent = "正篇与特别篇";
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
  }

  function findChapter(id) {
    for (const series of state.library.series) {
      const all = [...series.chapters, ...series.appendix];
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
    if (image) refs.singleCanvas.append(imageElement(image, state.chapter.title));
    refs.longCanvas.classList.add("hidden");
    refs.singleCanvas.classList.remove("hidden");
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
    refs.drawerLayer.hidden = true;
    refs.libraryToggle.setAttribute("aria-expanded", "false");
    try {
      const response = await fetch(`/api/chapter?chapter=${encodeURIComponent(chapterId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("章节读取失败");
      state.currentSeries = found.series;
      state.currentChapter = found.item;
      state.chapter = await response.json();
      state.activeIndex = savedPosition(state.currentChapter.id, state.chapter.images.length);
      refs.stage.scrollTo({ top: 0, left: 0, behavior: "auto" });
      renderReader();
      restoreScrollPosition();
      writeProgress();
    } catch (error) {
      showMessage("无法读取章节", error instanceof Error ? error.message : "请刷新后重试。");
    }
  }

  async function loadLibrary() {
    try {
      const response = await fetch("/api/library", { cache: "no-store" });
      if (!response.ok) throw new Error("目录服务返回异常");
      state.library = await response.json();
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
      showMessage("无法读取漫画目录", "请通过“启动漫画阅读器.command”启动，而不是直接双击 HTML 文件。服务端需要运行在 127.0.0.1 上。");
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
    if (action === "mode-long") { state.mode = "long"; localStorage.setItem(`${STORAGE_KEY}.mode`, state.mode); renderReader(); }
    if (action === "mode-single") { state.mode = "single"; localStorage.setItem(`${STORAGE_KEY}.mode`, state.mode); renderReader(); }
    if (action === "previous-chapter") moveChapter(-1);
    if (action === "next-chapter") moveChapter(1);
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (target) handleAction(target.dataset.action);
  });
  refs.libraryToggle.addEventListener("click", () => setDrawer(true));
  refs.emptyOpenLibrary.addEventListener("click", () => setDrawer(true));
  refs.messageDismiss.addEventListener("click", hideMessage);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !refs.drawerLayer.hidden) setDrawer(false);
    if (event.key === "ArrowLeft") movePage(-1);
    if (event.key === "ArrowRight") movePage(1);
    if (event.key === "PageUp") { event.preventDefault(); refs.stage.scrollBy({ top: -refs.stage.clientHeight * .85, behavior: "smooth" }); }
    if (event.key === "PageDown") { event.preventDefault(); refs.stage.scrollBy({ top: refs.stage.clientHeight * .85, behavior: "smooth" }); }
  });

  setTheme(state.theme);
  loadLibrary();
})();

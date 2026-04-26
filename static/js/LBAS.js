let currentID = null;
      let currentToken = null;
      let selectedCategory = "All";
      let availableCategories = [];
      let leaderboardProfileModal = null;
      let dataInterval = null;
      let timerInterval = null;
      const DEFAULT_DESKTOP_BOOK_LIMIT = 20;
      const DEFAULT_MOBILE_BOOK_LIMIT = 10;
      const MAX_ACTIVE_RESERVATIONS = 5;
      const BORROW_DURATION_MS = 2 * 24 * 60 * 60 * 1000;
      let userReservations = {};
      let userActiveLeases = {};
      let pendingReservationRequests = new Set();
      let pendingReserveBookNo = null;
      let currentProfile = null;
      let isGuestMode = true;
      let latestBooksByCode = {};
      let allCollectionOrder = [];
      let categoryCollectionOrder = {};
      let lbasInitialized = false;
      let hasShownSessionNotice = false;
      let accountSwipeStartX = null;
      let accountSwipeStartY = null;
      let accountSwipeCloseTriggered = false;
      const ACCOUNT_SWIPE_CLOSE_THRESHOLD = 80;

      function normalizeBookStatus(statusValue) {
        return String(statusValue || "Available").trim() || "Available";
      }

      function isMobileViewport() {
        return window.matchMedia("(max-width: 768px)").matches;
      }

      function getDisplayLimits() {
        const desktop = Number(localStorage.getItem("lbas_books_desktop") || DEFAULT_DESKTOP_BOOK_LIMIT);
        const mobile = Number(localStorage.getItem("lbas_books_mobile") || DEFAULT_MOBILE_BOOK_LIMIT);
        const activeLimit = isMobileViewport() ? mobile : desktop;
        return { activeLimit, desktop, mobile };
      }

      function hydrateDisplaySettings() {
        const { desktop, mobile } = getDisplayLimits();
        const desktopField = document.getElementById("booksPerPageDesktop");
        const mobileField = document.getElementById("booksPerPageMobile");
        if (desktopField) desktopField.value = desktop;
        if (mobileField) mobileField.value = mobile;
      }

      function saveDisplaySettings() {
        const desktop = Number(document.getElementById("booksPerPageDesktop")?.value || DEFAULT_DESKTOP_BOOK_LIMIT);
        const mobile = Number(document.getElementById("booksPerPageMobile")?.value || DEFAULT_MOBILE_BOOK_LIMIT);
        localStorage.setItem("lbas_books_desktop", String(Math.min(60, Math.max(6, desktop))));
        localStorage.setItem("lbas_books_mobile", String(Math.min(40, Math.max(4, mobile))));
        allCollectionOrder = [];
        categoryCollectionOrder = {};
        loadData();
      }

      function shuffleBooks(books) {
        const shuffled = [...books];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
      }

      function getRandomizedAllCollection(books, limit) {
        const grouped = books.reduce((acc, book) => {
          const key = book.category || "General";
          if (!acc[key]) acc[key] = [];
          acc[key].push(book);
          return acc;
        }, {});

        const pools = Object.values(grouped)
          .map((group) => shuffleBooks(group))
          .filter((group) => group.length > 0);

        const mixed = [];
        while (mixed.length < limit && pools.some((pool) => pool.length > 0)) {
          pools.forEach((pool) => {
            if (pool.length > 0 && mixed.length < limit) {
              mixed.push(pool.pop());
            }
          });
        }
        return shuffleBooks(mixed);
      }

      function normalizeReservation(transaction) {
        return {
          book_no: transaction.book_no,
          expiry: transaction.expiry || null,
        };
      }

      function getReservationKey(schoolID) {
        return String(schoolID || "").trim().toLowerCase();
      }

      function getNormalizedStatus(transaction) {
        return String(transaction?.status || "").trim().toLowerCase();
      }

      function getTransactionSchoolId(transaction) {
        return getReservationKey(transaction?.school_id ?? transaction?.schoolID ?? transaction?.user_id);
      }

      function parseTransactionPayload(payload) {
        if (Array.isArray(payload)) return payload;
        if (payload && Array.isArray(payload.transactions)) return payload.transactions;
        return [];
      }

      function normalizeLease(transaction) {
        let expiryDate = null;
        if (transaction.expiry) {
          expiryDate = new Date(transaction.expiry);
        } else if (transaction.date && getNormalizedStatus(transaction) === "borrowed") {
          expiryDate = new Date(new Date(transaction.date).getTime() + BORROW_DURATION_MS);
        }

        const book = latestBooksByCode[transaction.book_no] || {};
        return {
          book_no: transaction.book_no,
          title: transaction.title || book.title || "Unknown Title",
          status: transaction.status,
          expiry: expiryDate ? expiryDate.toISOString() : null,
          pickup_schedule: transaction.pickup_schedule || "",
          pickup_at: transaction.pickup_at || transaction.unavailable_at || "",
          borrowed_by: transaction.borrowed_by || "",
          queue_position: transaction.queue_position,
          queue_total: transaction.queue_total,
          same_slot_conflict: !!transaction.same_slot_conflict,
        };
      }

      function cleanupExpiredReservationsForUser(schoolID) {
        const key = getReservationKey(schoolID);
        const now = Date.now();

        if (!Array.isArray(userReservations[key])) {
          userReservations[key] = [];
        }

        userReservations[key] = userReservations[key].filter((reservation) => {
          const expiryTime = new Date(reservation.expiry).getTime();
          return Number.isFinite(expiryTime) && expiryTime > now;
        });

        return userReservations[key];
      }

      function syncUserReservations(transactions, schoolID) {
        if (!schoolID) return [];

        const key = getReservationKey(schoolID);

        const reservations = transactions
          .filter(
            (transaction) =>
              getTransactionSchoolId(transaction) === key &&
              getNormalizedStatus(transaction) === "reserved",
          )
          .map(normalizeReservation);

        userReservations[key] = reservations;
        return cleanupExpiredReservationsForUser(schoolID);
      }

      function cleanupExpiredLeasesForUser(schoolID) {
        const key = getReservationKey(schoolID);
        const now = Date.now();

        if (!Array.isArray(userActiveLeases[key])) {
          userActiveLeases[key] = [];
        }

        userActiveLeases[key] = userActiveLeases[key].filter((lease) => {
          const leaseStatus = getNormalizedStatus(lease);
          if (["reserved", "unavailable", "missed"].includes(leaseStatus)) return true;
          const expiryTime = new Date(lease.expiry).getTime();
          return Number.isFinite(expiryTime) && expiryTime > now;
        });

        return userActiveLeases[key];
      }

      function syncUserActiveLeases(transactions, schoolID) {
        if (!schoolID) return [];
        const key = getReservationKey(schoolID);
        const leases = transactions
          .filter(
            (transaction) => {
              const status = getNormalizedStatus(transaction);
              return (
                getTransactionSchoolId(transaction) === key &&
                (status === "reserved" || status === "borrowed" || status === "unavailable" || status === "missed")
              );
            },
          )
          .map(normalizeLease);

        userActiveLeases[key] = leases;
        return cleanupExpiredLeasesForUser(schoolID);
      }

      function formatPickupDateTime(schedule) {
        if (!schedule) return "Not set";
        const parts = schedule.split(" ");
        const date = parts[0] || "";
        if (parts.length < 2) return date;
        const [h, m] = parts[1].split(":").map(Number);
        const period = h >= 12 ? "PM" : "AM";
        const hour12 = h % 12 || 12;
        return `${date} at ${hour12}:${String(m).padStart(2, "0")} ${period}`;
      }

      function renderActiveLeases() {
        if (!currentID) {
          const reservationCountNode = document.getElementById("reservationCount");
          if (reservationCountNode) reservationCountNode.textContent = "0";
          const activeHistory = document.getElementById("activeHistory");
          if (activeHistory) activeHistory.innerHTML = '<p class="text-muted small text-center mt-3 border p-3 rounded-3 dashed">Log in to view active reservations.</p>';
          return;
        }
        const key = getReservationKey(currentID);
        const active = cleanupExpiredLeasesForUser(key)
          .slice()
          .sort((a, b) => new Date(a.expiry) - new Date(b.expiry));
        const reservationCount = active.filter(
          (lease) => getNormalizedStatus(lease) === "reserved",
        ).length;

        const reservationCountNode = document.getElementById("reservationCount");
        if (reservationCountNode) {
          reservationCountNode.textContent = String(reservationCount);
        }

        const activeLeaseLabel = document.getElementById("activeLeaseLabel");
        if (activeLeaseLabel) {
          activeLeaseLabel.innerHTML = `<i class="fas fa-history me-1"></i> Active Leases (${active.length}/${MAX_ACTIVE_RESERVATIONS})`;
        }

        document.getElementById("activeHistory").innerHTML =
          active
            .map(
              (lease) => `
                <div class="reservation-card mb-2 d-flex justify-content-between align-items-center gap-2">
                  <div>
                    <div class="fw-bold">${lease.title}</div>
                    <code class="small fw-bold">${lease.book_no}</code><br>
                    <span class="badge ${getNormalizedStatus(lease) === "reserved" ? "status-badge" : getNormalizedStatus(lease) === "missed" ? "bg-danger" : getNormalizedStatus(lease) === "unavailable" ? "bg-secondary" : "bg-success"}">${getNormalizedStatus(lease) === "unavailable" ? "BORROWED BY OTHER" : lease.status}</span>
                  </div>
                  <div class="text-end">
                    ${getNormalizedStatus(lease) === "reserved"
                      ? (Number(lease.queue_position) > 1
                        ? `<span class="small fw-bold text-muted d-block">In queue — position #${lease.queue_position} of ${lease.queue_total || lease.queue_position}</span><span class="small text-muted d-block">Your slot: ${formatPickupDateTime(lease.pickup_schedule)}</span>`
                        : lease.same_slot_conflict
                          ? `<span class="small fw-bold text-warning d-block">Awaiting pickup — same slot as another user. First to arrive gets the book!</span><span class="small text-muted d-block">Pickup slot: ${formatPickupDateTime(lease.pickup_schedule)}</span>`
                          : `<span class="small fw-bold text-warning d-block">Awaiting pickup</span><span class="small text-muted d-block">Pickup slot: ${formatPickupDateTime(lease.pickup_schedule)}</span>`)
                      : getNormalizedStatus(lease) === "missed"
                        ? `<span class="small fw-bold text-danger d-block">Failed to Pick Up</span>`
                        : getNormalizedStatus(lease) === "unavailable"
                          ? `<span class="small fw-bold text-danger d-block">Book is no longer available (borrowed by another user)</span><span class="small text-muted d-block">Borrowed by: ${lease.borrowed_by || "Unknown user"}</span><span class="small text-muted d-block">Picked up at: ${formatPickupDateTime(lease.pickup_at)}</span><span class="small text-muted d-block">Picked up: ${formatPickupDateTime(lease.pickup_at)}</span>`
                          : `<span class="timer small fw-bold d-block" data-expiry="${lease.expiry}" data-status="${lease.status}" data-book-no="${lease.book_no}">Calculating...</span>`}
                    ${["reserved","unavailable","missed"].includes(getNormalizedStatus(lease)) ? `<button class="btn btn-sm btn-outline-danger rounded-pill mt-1 cancel-reservation-btn" onclick="cancelReservation('${lease.book_no}')">Remove Reservation List</button>` : ""}
                  </div>
                </div>`,
            )
            .join("") ||
          '<p class="text-muted small text-center mt-3 border p-3 rounded-3 dashed">No active reservations.</p>';

        updateTimers();
      }

      async function loadReservations() {
        if (!currentID) return;
        try {
          console.log("[LBAS] fetch -> /api/transactions (reservations)");
          const tRes = await fetch("/api/transactions");
          console.log("[LBAS] fetch <- /api/transactions", tRes.status);
          const trans = parseTransactionPayload(await tRes.json());
          if (currentID) {
            syncUserReservations(trans, currentID);
            syncUserActiveLeases(trans, currentID);
          }
          renderActiveLeases();
        } catch (e) {
          console.error("Unable to refresh reservations.");
        }
      }

      async function fetchUserActiveReservations() {
        await loadReservations();
      }

      function setStudentLoginStep(step) {
        const welcome = document.getElementById("studentWelcomeStep");
        const manual = document.getElementById("studentManualStep");
        const login = document.getElementById("studentLoginCard");
        const prev = document.getElementById("studentPrevBtn");
        const next = document.getElementById("studentNextBtn");
        const isMobile = window.innerWidth <= 768;
        if (!welcome || !manual || !login) return;

        welcome.classList.add("hidden-step");
        manual.classList.add("hidden-step");
        login.classList.add("hidden-step");
        login.classList.remove("show-login");

        if (isMobile) {
          login.classList.add("hidden-mobile");
        } else {
          login.classList.remove("hidden-mobile");
        }

        if (step === "manual") {
          manual.classList.remove("hidden-step");
          if (prev) prev.disabled = false;
          if (next) next.disabled = false;
          return;
        }
        if (step === "login") {
          login.classList.remove("hidden-step");
          if (isMobile) {
            login.classList.remove("hidden-mobile");
            login.classList.add("show-login");
          }
          if (prev) prev.disabled = false;
          if (next) next.disabled = true;
          return;
        }
        welcome.classList.remove("hidden-step");
        if (prev) prev.disabled = true;
        if (next) next.disabled = false;
      }

      const studentLoginSteps = ["welcome", "manual", "login"];

      function shiftStudentLoginStep(direction) {
        const activeStep = studentLoginSteps.find((stepName) => {
          const map = {
            welcome: "studentWelcomeStep",
            manual: "studentManualStep",
            login: "studentLoginCard",
          };
          const el = document.getElementById(map[stepName]);
          return el && !el.classList.contains("hidden-step");
        }) || "welcome";

        const nextIndex = Math.min(
          Math.max(studentLoginSteps.indexOf(activeStep) + direction, 0),
          studentLoginSteps.length - 1,
        );
        setStudentLoginStep(studentLoginSteps[nextIndex]);
      }

      function jumpToStudentLogin() {
        setStudentLoginStep("login");
      }

      function initStudentLoginSwipe() {
        const slider = document.querySelector(".welcome-slider-wrap");
        if (!slider) return;

        let startX = 0;
        let startY = 0;

        slider.addEventListener("touchstart", (event) => {
          const touch = event.changedTouches?.[0];
          if (!touch) return;
          startX = touch.clientX;
          startY = touch.clientY;
        }, { passive: true });

        slider.addEventListener("touchend", (event) => {
          if (window.innerWidth > 768) return;
          const touch = event.changedTouches?.[0];
          if (!touch) return;

          const deltaX = touch.clientX - startX;
          const deltaY = touch.clientY - startY;
          if (Math.abs(deltaX) < 45 || Math.abs(deltaX) < Math.abs(deltaY)) return;

          shiftStudentLoginStep(deltaX < 0 ? 1 : -1);
        }, { passive: true });
      }

      window.addEventListener("resize", () => {
        const activeStep = studentLoginSteps.find((stepName) => {
          const map = {
            welcome: "studentWelcomeStep",
            manual: "studentManualStep",
            login: "studentLoginCard",
          };
          const el = document.getElementById(map[stepName]);
          return el && !el.classList.contains("hidden-step");
        }) || "welcome";
        setStudentLoginStep(activeStep);
      });


      function updateAuthMenus() {
        const isLoggedIn = isAuthenticatedUser();
        const authToggle = document.getElementById("lbasAuthToggle");
        const managementItem = document.getElementById("lbasStudentManagementItem");
        const authAction = document.getElementById("lbasAuthAction");

        if (authToggle) authToggle.textContent = isLoggedIn ? "Account" : "Log in";
        if (managementItem) managementItem.style.display = "";
        if (authAction) {
          authAction.textContent = isLoggedIn ? "Log out" : "Log in";
          authAction.href = isLoggedIn ? "#" : "/student-management";
          authAction.onclick = isLoggedIn
          ? () => { logout(); return false; }
          : null;
        }
      }

      function notifySessionAutoLogout() {
        if (hasShownSessionNotice) return;
        hasShownSessionNotice = true;
        showStatusPopup(
          "warning",
          "Session Notice",
          "For account safety, your session will automatically log out when you leave this page or close the browser.",
        );
      }


      function isAuthenticatedUser() {
        return Boolean(currentID && currentToken);
      }

      async function handleLogin() {
        const id = document.getElementById("school_id_input").value.trim();
        const password = document.getElementById("school_password_input")?.value.trim();
        if (!id || !password) return;

        const btn = document.getElementById("loginBtn");
        const err = document.getElementById("loginError");
        const errTxt = document.getElementById("errorText");

        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> VERIFYING...';
        btn.disabled = true;
        err.style.display = "none";

        try {
          const res = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ school_id: id, password }),
          });

          const data = await res.json();

          if (data.success) {
            currentID = id;
            currentToken = data.token;
            localStorage.setItem("lbas_id", id);
            localStorage.setItem("lbas_token", currentToken);
            notifySessionAutoLogout();
            initPortal(data.profile);
            const returnTo = new URLSearchParams(window.location.search).get("return_to");
            if (returnTo) {
              window.location.href = decodeURIComponent(returnTo);
            }
          } else {
            err.style.display = "block";
            if (res.status === 401 && data.message.includes("Pending")) {
              showStatusPopup(
                "warning",
                "Approval Pending",
                "Your account still Pending for approval",
              );
              err.style.display = "none"; // Hide the red error box if showing popup
            } else if (res.status === 404) {
              errTxt.innerText = "ID NOT FOUND / REQUEST REJECTED";
            } else {
              errTxt.innerText = data.message || "AUTHENTICATION FAILED";
            }
          }
        } catch (e) {
          err.style.display = "block";
          errTxt.innerText = "SERVER UNREACHABLE";
        } finally {
          btn.innerText = "LOG IN";
          btn.disabled = false;
        }
      }

      function showStatusPopup(type, title, msg) {
        const icon = document.getElementById("statusIcon");
        const h4 = document.getElementById("statusTitle");

        document.getElementById("statusMsg").innerText = msg;

        if (type === "success") {
          icon.className = "fas fa-check-circle text-success";
          h4.className = "fw-bold text-success";
        } else if (type === "warning") {
          icon.className = "fas fa-clock text-warning";
          h4.className = "fw-bold text-warning";
        } else {
          icon.className = "fas fa-times-circle text-danger";
          h4.className = "fw-bold text-danger";
        }

        h4.innerText = title;
        toggleModal("statusModal", true);
      }

      function escapeHtmlAttr(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      }

      function renderCategoryFilters() {
        const list = document.getElementById("catFilterList");
        if (!list) return;
        let html = `<button type="button" class="cat-pill category-btn ${selectedCategory === "All" ? "active" : ""}" data-category="All">All Collection</button>`;
        availableCategories.forEach((cat) => {
          const safeCategory = escapeHtmlAttr(cat);
          html += `<button type="button" class="cat-pill category-btn ${selectedCategory === cat ? "active" : ""}" data-category="${safeCategory}">${safeCategory}</button>`;
        });
        list.innerHTML = html;
      }

      async function fetchCategories() {
        try {
          const res = await fetch("/api/categories");
          const cats = await res.json();
          availableCategories = Array.isArray(cats) ? cats : [];
          renderCategoryFilters();
        } catch (e) {
          availableCategories = [
            "General",
            "Mathematics",
            "Science",
            "Literature",
          ];
          renderCategoryFilters();
        }
      }

      function switchPortalView(view) {
        const isLeaderboard = view === "leaderboard";
        document.getElementById("catalogSection").style.display = isLeaderboard
          ? "none"
          : "block";
        document.getElementById("leaderboardSection").style.display =
          isLeaderboard ? "block" : "none";
        document
          .getElementById("catalogMenuBtn")
          .classList.toggle("active", !isLeaderboard);
        document
          .getElementById("leaderboardMenuBtn")
          .classList.toggle("active", isLeaderboard);
        if (isLeaderboard) {
          loadLeaderboard();
        }
      }

      async function loadLeaderboard() {
        try {
          const res = await fetch("/api/monthly_leaderboard");
          const data = await res.json();
          const rows = Array.isArray(data?.top_borrowers)
            ? data.top_borrowers
            : [];
          document.getElementById("leaderboardBorrowersBody").innerHTML =
            rows
              .map(
                (row, idx) => `
                  <tr role="button" onclick="openLeaderboardProfile('${row.school_id}')">
                    <td class="fw-bold leaderboard-rank">#${row.rank || idx + 1}</td>
                    <td>
                      <div class="d-flex align-items-center gap-2">
                        <img src="/Profile/${row.photo || "default.png"}" class="rounded-circle" style="width:36px;height:36px;object-fit:cover;" alt="${row.name}">
                        <div>
                          <div class="fw-bold">${row.name || row.school_id}</div>
                          <div class="small text-muted">${row.school_id}</div>
                        </div>
                      </div>
                    </td>
                    <td class="fw-bold leaderboard-total">${row.total_borrowed}</td>
                  </tr>
            `,
              )
              .join("") ||
            '<tr><td colspan="3" class="text-muted text-center py-4">No borrow records yet for this month.</td></tr>';
        } catch (e) {
          document.getElementById("leaderboardBorrowersBody").innerHTML =
            '<tr><td colspan="3" class="text-danger text-center py-4">Unable to load leaderboard.</td></tr>';
        }
      }

      async function openLeaderboardProfile(id) {
        try {
          const res = await fetch(
            "/api/leaderboard_profile/" + encodeURIComponent(id),
          );
          const data = await res.json();
          if (!res.ok || !data.success) throw new Error();
          const p = data.profile;
          document.getElementById("leaderboardProfilePhoto").src =
            `/Profile/${p.photo || "default.png"}`;
          document.getElementById("leaderboardProfileName").innerText =
            p.name || p.school_id;
          document.getElementById("leaderboardProfileId").innerText =
            `ID: ${p.school_id || "-"}`;
          document.getElementById("leaderboardProfileTotal").innerText =
            p.total_borrowed ?? 0;
          document.getElementById("leaderboardProfileBook").innerText =
            p.most_borrowed_book || "No records";
          if (leaderboardProfileModal) {
            leaderboardProfileModal.show();
          }
        } catch (e) {
          console.error("Unable to load leaderboard profile.");
        }
      }

      function initPortal(profile) {
        if (!profile) return logout();
        isGuestMode = false;

        if (dataInterval) clearInterval(dataInterval);
        if (timerInterval) clearInterval(timerInterval);

        document.getElementById("loginSection").style.display = "none";
        document.getElementById("portalSection").style.display = "block";

        updateAuthMenus();
        currentProfile = profile;
        const isLibrarian = profile.category === "Staff";

        if (isLibrarian) {
          document.getElementById("lbasInfo").style.display = "block";
        }

        document.getElementById("user_type_label").innerText = isLibrarian
          ? "LIBRARIAN MODE"
          : "STUDENT ACCESS";
        document.getElementById("user_type_label").className = isLibrarian
          ? "badge bg-danger text-uppercase mb-1"
          : "badge bg-primary text-uppercase mb-1";
        document.getElementById("database_source").innerText = isLibrarian
          ? "CREDENTIAL: STAFF"
          : "CREDENTIAL: USER";

        document.getElementById("display_name").innerText = profile.name
          ? profile.name.split(" ")[0]
          : "User";
        document.getElementById("full_name").innerText =
          profile.name || "Unknown User";
        document.getElementById("id_val").innerText =
          "ID: " + profile.school_id;
        document.getElementById("user_pic").src = profile.photo
          ? "/Profile/" + profile.photo
          : "/Profile/default.png";
        switchPortalView("catalog");
        hydrateDisplaySettings();

        fetchCategories();
        fetchUserActiveReservations();
        loadData();
        dataInterval = setInterval(loadData, 5000);
        timerInterval = setInterval(updateTimers, 1000);
      }

      async function loadData() {
        try {
          await fetchCategories();
          const authHeaders = currentToken
            ? { Authorization: currentToken }
            : {};
          const bRes = await fetch("/api/books", { headers: authHeaders });
          const tRes = isAuthenticatedUser()
            ? await fetch("/api/transactions", { headers: authHeaders })
            : null;

          if (!bRes.ok) {
            document.getElementById("bookContainer").innerHTML =
              '<div class="text-center text-danger mt-5"><i class="fas fa-lock fa-2x mb-3"></i><br>Unable to load books right now.</div>';
            return;
          }

          const books = await bRes.json();
          const trans = tRes && tRes.ok
            ? parseTransactionPayload(await tRes.json())
            : [];

          if (!Array.isArray(books)) {
            document.getElementById("bookContainer").innerHTML =
              '<div class="text-center text-danger mt-5"><i class="fas fa-exclamation-triangle fa-2x mb-3"></i><br>Book data is unavailable right now.</div>';
            return;
          }

          latestBooksByCode = books.reduce((acc, book) => {
            acc[book.book_no] = book;
            return acc;
          }, {});
          if (currentID) {
            syncUserReservations(trans, currentID);
            syncUserActiveLeases(trans, currentID);
          }
          const search = document
            .getElementById("searchBar")
            .value.toLowerCase();
          const isSearching = search.length > 0;

          const filtered = books.filter((b) => {
            const title = String(b?.title || "").toLowerCase();
            const bookNo = String(b?.book_no || "").toLowerCase();
            const matchesSearch =
              title.includes(search) ||
              bookNo.includes(search);
            const matchesCategory =
              isSearching ||
              selectedCategory === "All" ||
              b.category === selectedCategory;
            return matchesSearch && matchesCategory;
          });

          if (allCollectionOrder.length === 0) {
            const { activeLimit } = getDisplayLimits();
            allCollectionOrder = getRandomizedAllCollection(books, activeLimit).map(
              (book) => book.book_no,
            );
          }

          const categoryKey = selectedCategory;
          if (
            !isSearching &&
            selectedCategory !== "All" &&
            !categoryCollectionOrder[categoryKey]
          ) {
            const { activeLimit } = getDisplayLimits();
            categoryCollectionOrder[categoryKey] = shuffleBooks(filtered)
              .slice(0, activeLimit)
              .map((book) => book.book_no);
          }

          const displayBooks = isSearching
            ? filtered
            : selectedCategory === "All"
              ? allCollectionOrder
                  .map((bookNo) => latestBooksByCode[bookNo])
                  .filter((book) => book && filtered.some((f) => f.book_no === book.book_no))
              : (categoryCollectionOrder[categoryKey] || [])
                  .map((bookNo) => latestBooksByCode[bookNo])
                  .filter(Boolean);

          document.getElementById("bookContainer").innerHTML =
            displayBooks
              .map(
                (b) => {
                  const normalizedStatus = normalizeBookStatus(b?.status);
                  const normalizedStatusKey = normalizedStatus.toLowerCase().replace(/[^a-z0-9_-]/g, "");
                  const categoryLabel = String(b?.category || "General").toUpperCase();
                  const title = String(b?.title || "Untitled");
                  const bookNo = String(b?.book_no || "N/A");
                  const isBorrowed = normalizedStatus.toLowerCase() === "borrowed";
                  return `
                <div class="book-item shadow-sm">
                    <span class="status-tag tag-${normalizedStatusKey}">${normalizedStatus}</span>
                    <span class="text-muted" style="font-size: 10px; font-weight:700;">${categoryLabel}</span>
                    <div class="fw-bold text-dark mt-1">${title}</div>
                    <code class="small text-primary fw-bold">${bookNo}</code>
                    ${!isBorrowed ? `<button class="btn-action shadow-sm reserve-book-btn" data-book-no="${bookNo}" onclick="reserveBook('${bookNo}')">RESERVE BOOK</button>` : ""}
                </div>`;
                },
              )
              .join("") ||
            '<div class="text-center text-muted mt-5"><i class="fas fa-book-open fa-2x mb-3 opacity-25"></i><br>No books found.</div>';

          renderActiveLeases();
        } catch (e) {
          console.error("Data Sync Error");
        }
      }

      function reserveBook(no) {
        if (!no) return;
        if (pendingReservationRequests.has(no)) return;

        if (!isAuthenticatedUser()) {
          const returnTo = encodeURIComponent(`/lbas?reserve=${encodeURIComponent(no)}`);
          window.location.href = `/student-management?return_to=${returnTo}`;
          return;
        }
        submitReserveForm(no);
      }

      async function checkDateRestriction(dateValue) {
        if (!dateValue) return { restricted: false };
        try {
          const res = await fetch(`/api/date_restrictions/check?date=${encodeURIComponent(dateValue)}`);
          const data = await res.json();
          if (!res.ok || !data.success) return { restricted: false };
          return data;
        } catch (error) {
          return { restricted: false };
        }
      }

      async function submitReserveForm(bookNo) {
        const no = bookNo || pendingReserveBookNo;
        if (!no) return;

        const reserveButton = document.querySelector(`button[data-book-no="${no}"]`);
        if (pendingReservationRequests.has(no)) return;

        pendingReservationRequests.add(no);
        if (reserveButton) reserveButton.disabled = true;
        const userDisplayName = String(currentProfile?.name || document.getElementById("full_name")?.innerText || currentID || "").trim();
        const defaultContact = String(currentProfile?.phone_number || currentProfile?.email || "N/A").trim();
        const contactType = currentProfile?.email ? "email" : "phone";

        try {
          const res = await fetch("/api/reserve", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(currentToken ? { Authorization: currentToken } : {}),
            },
            body: JSON.stringify({
              book_no: no,
              school_id: currentID,
              borrower_name: userDisplayName,
              pickup_location: "Main Library",
              pickup_schedule: "",
              reservation_note: "Quick reserve from Book Display",
              request_id: `REQ-${Date.now().toString(36).toUpperCase()}`,
              phone_number: defaultContact,
              contact_type: contactType,
            }),
          });

          const result = await res.json();

          if (!res.ok || !result.success || result.status === "error") {
            alert(result.message || "Unable to complete reservation.");
            return;
          }

          const key = getReservationKey(currentID);
          if (!Array.isArray(userReservations[key])) userReservations[key] = [];
          if (!Array.isArray(userActiveLeases[key])) userActiveLeases[key] = [];

          const leaseTitle = (latestBooksByCode[no] && latestBooksByCode[no].title) ||
            result.title ||
            "Unknown Title";

          userReservations[key].push({
            book_no: no,
            expiry: null,
          });
          userActiveLeases[key] = userActiveLeases[key].filter(
            (lease) => lease.book_no !== no,
          );
          userActiveLeases[key].push({
            book_no: no,
            title: leaseTitle,
            status: "Reserved",
            expiry: null,
          });
          renderActiveLeases();
          pendingReserveBookNo = null;

          showStatusPopup(
            "success",
            "Reservation Confirmed",
            "Reservation submitted. Please wait for admin approval and pickup confirmation.",
          );
          await loadReservations();
          loadData();
        } catch (e) {
          showStatusPopup(
            "error",
            "Action Failed",
            "Unable to complete reservation right now. Please try again.",
          );
        } finally {
          pendingReservationRequests.delete(no);
          if (reserveButton) reserveButton.disabled = false;
        }
      }

      async function cancelReservation(bookNo) {
        if (!currentID || !bookNo) return;
        if (!confirm("Release this reservation?")) return;

        try {
          const res = await fetch("/api/cancel_reservation", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(currentToken ? { Authorization: currentToken } : {}),
            },
            body: JSON.stringify({
              book_no: bookNo,
                            school_id: currentID,
            }),
          });
          const data = await res.json();
          if (!res.ok || !data?.success) {
            alert(data.message || "Unable to cancel reservation.");
            return;
          }

          const key = getReservationKey(currentID);
          userReservations[key] = (userReservations[key] || []).filter(
            (reservation) => reservation.book_no !== bookNo,
          );
          userActiveLeases[key] = (userActiveLeases[key] || []).filter(
            (lease) => lease.book_no !== bookNo,
          );
          renderActiveLeases();
          await loadReservations();
          loadData();
        } catch (e) {
          alert("Unable to release reservation right now.");
        }
      }

      function setCategoryFilter(cat) {
        selectedCategory = cat;
        document.querySelectorAll("#catFilterList .category-btn").forEach((p) => {
          p.classList.toggle("active", p.dataset.category === cat);
        });
        loadData();
      }

      function updateTimers() {
        let foundExpiredReservation = false;
        let timerCount = 0;
        document.querySelectorAll(".timer").forEach((el) => {
          timerCount += 1;
          if (!el.dataset.expiry) {
            el.innerText = "Awaiting librarian confirmation";
            return;
          }
          const diff = new Date(el.dataset.expiry) - new Date();
          if (diff <= 0) {
            if (el.dataset.status === "Reserved") {
              foundExpiredReservation = true;
              return;
            }
            el.innerText = "EXPIRED";
            el.classList.add("text-danger");
          } else {
            const m = Math.floor(diff / 60000);
            const s = Math.floor((diff % 60000) / 1000);
            el.innerText = `${m}m ${s}s remaining`;
          }
        });
        if (timerCount > 0) {
          console.log("[LBAS] timer tick", { timerCount });
        }

        if (foundExpiredReservation) {
          cleanupExpiredReservationsForUser(currentID);
          cleanupExpiredLeasesForUser(currentID);
          renderActiveLeases();
        }
      }

      function previewPhoto(input) {
        if (!(input.files && input.files[0])) return;
        const reader = new FileReader();
        reader.onload = function (event) {
          const preview = document.getElementById("previewImg");
          const icon = document.getElementById("uploadIcon");
          if (preview && event.target?.result) {
            preview.src = event.target.result;
            preview.style.display = "block";
          }
          if (icon) icon.style.display = "none";
        };
        reader.readAsDataURL(input.files[0]);
      }

      async function parseJsonSafe(response) {
        try {
          return await response.json();
        } catch (_error) {
          return null;
        }
      }

      async function loadCoursesIntoSelect() {
        try {
          const res = await fetch('/api/courses');
          const data = await res.json();
          const courses = data.courses || [];
          const select = document.getElementById('signUpCourse');
          if (!select) return;
          select.innerHTML = '<option value="">Select Course</option>' + courses.map((c) => `<option value="${c}">${c}</option>`).join('');
        } catch (_e) {
          console.warn('Could not load courses');
        }
      }

      function showSignUpError(message) {
        const errorEl = document.getElementById('signUpError');
        if (!errorEl) return;
        errorEl.hidden = false;
        errorEl.textContent = message;
      }

      function handleSignUpLevelChange() {
        const isHS = document.getElementById('signUpLevelHS')?.checked;
        const yearSelect = document.getElementById('signUpYear');
        const courseSelect = document.getElementById('signUpCourse');
        const fgCourse = document.getElementById('fgSignUpCourse');
        if (!yearSelect) return;

        if (isHS) {
          yearSelect.innerHTML = '<option value="">Select Grade</option>' + [7, 8, 9, 10].map((g) => `<option value="${g}">Grade ${g}</option>`).join('');
          if (courseSelect) courseSelect.innerHTML = '<option value="N/A">N/A</option>';
          if (fgCourse) {
            fgCourse.style.opacity = '0.5';
            fgCourse.style.pointerEvents = 'none';
          }
        } else {
          yearSelect.innerHTML = '<option value="">Select Year</option>' + [1, 2, 3, 4].map((y) => `<option value="${y}">${y === 1 ? '1st' : y === 2 ? '2nd' : y === 3 ? '3rd' : '4th'} Year</option>`).join('');
          loadCoursesIntoSelect();
          if (fgCourse) {
            fgCourse.style.opacity = '1';
            fgCourse.style.pointerEvents = 'auto';
          }
        }
      }

      async function submitSignUp() {
        const name = document.getElementById('signUpName')?.value.trim() || '';
        const schoolId = (document.getElementById('signUpId')?.value || '').trim().toLowerCase();
        const yearLevel = document.getElementById('signUpYear')?.value || '';
        const isHS = document.getElementById('signUpLevelHS')?.checked;
        const schoolLevel = isHS ? 'highschool' : 'college';
        const course = isHS ? 'N/A' : (document.getElementById('signUpCourse')?.value || '');
        const password = document.getElementById('signUpPassword')?.value || '';
        const confirm = document.getElementById('signUpConfirm')?.value || '';
        const photoFile = document.getElementById('signUpPhotoFile')?.files?.[0];

        const errorEl = document.getElementById('signUpError');
        if (errorEl) errorEl.hidden = true;

        if (!name) return showSignUpError('Please enter your student name.');
        if (!schoolId) return showSignUpError('Please enter your School ID.');
        if (!yearLevel) return showSignUpError(isHS ? 'Please select your grade level.' : 'Please select your year level.');
        if (!isHS && !course) return showSignUpError('Please select your course.');
        if (!password) return showSignUpError('Please create a password.');
        if (password.length < 6) return showSignUpError('Password must be at least 6 characters.');
        if (password !== confirm) return showSignUpError('Passwords do not match.');

        const btn = document.getElementById('signUpSubmitBtn');
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Submitting...';
        }

        const fd = new FormData();
        fd.append('name', name);
        fd.append('school_id', schoolId);
        fd.append('year_level', yearLevel);
        fd.append('school_level', schoolLevel);
        fd.append('course', course);
        fd.append('password', password);
        fd.append('confirm', confirm);
        if (photoFile) fd.append('photo', photoFile);

        try {
          const res = await fetch('/api/register_request', { method: 'POST', body: fd });
          const data = await res.json();

          if (data.success) {
            ['fgSignUpName', 'fgSignUpId', 'fgSignUpLevel', 'fgSignUpYear', 'fgSignUpCourse', 'fgSignUpPassword', 'fgSignUpConfirm', 'fgSignUpReqNum'].forEach((id) => {
              const el = document.getElementById(id);
              if (el) el.style.display = 'none';
            });
            const circle = document.getElementById('signUpPhotoCircle');
            const hint = document.querySelector('.signup-photo-hint');
            if (circle) circle.style.display = 'none';
            if (hint) hint.style.display = 'none';
            if (btn) btn.style.display = 'none';
            const cancelBtn = document.getElementById('signUpCancelBtn');
            if (cancelBtn) cancelBtn.textContent = 'Close';
            const footerLink = document.getElementById('signUpFooterLink');
            if (footerLink) footerLink.style.display = 'none';
            const reqNumSpan = document.getElementById('signUpSuccessReqNum');
            if (reqNumSpan) reqNumSpan.textContent = `#${data.request_number}`;
            const successEl = document.getElementById('signUpSuccess');
            if (successEl) successEl.hidden = false;
            if (errorEl) errorEl.hidden = true;
          } else {
            if (btn) {
              btn.disabled = false;
              btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Request';
            }
            showSignUpError(data.message || 'Submission failed.');
          }
        } catch (_e) {
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Request';
          }
          showSignUpError('Connection error. Please try again.');
        }
      }


      function resetRegistrationForm() {
        ["signUpName", "signUpId", "signUpPassword", "signUpConfirm"].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.value = "";
        });
        const photoInput = document.getElementById("signUpPhotoFile");
        if (photoInput) photoInput.value = "";
        const preview = document.getElementById("previewImg");
        const icon = document.getElementById("uploadIcon");
        if (preview) {
          preview.removeAttribute("src");
          preview.style.display = "none";
        }
        if (icon) icon.style.display = "block";
      }

      function toggleModal(id, show) {
        document.getElementById(id).style.display = show ? "flex" : "none";
        if (id === "registerModal") {
          if (!show) {
            resetRegistrationForm();
          } else {
            const collegeRadio = document.getElementById("signUpLevelCollege");
            if (collegeRadio) collegeRadio.checked = true;
            handleSignUpLevelChange();
            loadCoursesIntoSelect();
            const yr = document.getElementById("signUpYear");
            if (yr) yr.value = "";
            const cs = document.getElementById("signUpCourse");
            if (cs) cs.value = "";
            const reqDisp = document.getElementById("signUpReqNumDisplay");
            if (reqDisp) reqDisp.textContent = "Auto-generated on submit";
            const success = document.getElementById("signUpSuccess");
            if (success) success.hidden = true;
            const err = document.getElementById("signUpError");
            if (err) err.hidden = true;
          }
        }
      }

      function openAccountModal() {
        const modal = document.getElementById("accountPanel");
        const overlay = document.getElementById("accountOverlay");
        if (!modal || !overlay) return;
        modal.classList.add("active");
        overlay.classList.add("active");
        if (!isMobileViewport()) {
          document.body.classList.add("account-open");
        }
      }

      function closeAccountModal() {
        const modal = document.getElementById("accountPanel");
        const overlay = document.getElementById("accountOverlay");
        if (!modal || !overlay) return;
        modal.classList.remove("active");
        overlay.classList.remove("active");
        document.body.classList.remove("account-open");
      }

      function attachAccountSwipeToClose() {
        const modal = document.getElementById("accountPanel");
        if (!modal) return;

        modal.addEventListener(
          "touchstart",
          (event) => {
            if (!isMobileViewport() || !modal.classList.contains("active")) return;
            const touch = event.touches?.[0];
            if (!touch) return;
            accountSwipeStartX = touch.clientX;
            accountSwipeStartY = touch.clientY;
            accountSwipeCloseTriggered = false;
          },
          { passive: true },
        );

        modal.addEventListener(
          "touchmove",
          (event) => {
            if (!isMobileViewport() || !modal.classList.contains("active") || accountSwipeCloseTriggered) return;
            const touch = event.touches?.[0];
            if (!touch || accountSwipeStartX === null || accountSwipeStartY === null) return;

            const deltaX = touch.clientX - accountSwipeStartX;
            const deltaY = Math.abs(touch.clientY - accountSwipeStartY);
            const isHorizontalSwipe = Math.abs(deltaX) > deltaY;
            if (isHorizontalSwipe && deltaX > ACCOUNT_SWIPE_CLOSE_THRESHOLD) {
              accountSwipeCloseTriggered = true;
              closeAccountModal();
            }
          },
          { passive: true },
        );

        modal.addEventListener(
          "touchend",
          () => {
            accountSwipeStartX = null;
            accountSwipeStartY = null;
            accountSwipeCloseTriggered = false;
          },
          { passive: true },
        );
      }

      function toggleAccount() {
        const modal = document.getElementById("accountPanel");
        if (!modal) return;
        const shouldOpen = !modal.classList.contains("active");
        if (shouldOpen) {
          openAccountModal();
        } else {
          closeAccountModal();
        }
      }

      function attachAccountTapToClose() {
        const modal = document.getElementById("accountPanel");
        if (!modal) return;
        let tapStart = 0;
        modal.addEventListener("touchstart", () => {
          if (!isMobileViewport() || !modal.classList.contains("active")) return;
          tapStart = Date.now();
        }, { passive: true });
        modal.addEventListener("touchend", () => {
          if (!isMobileViewport() || !modal.classList.contains("active")) return;
          if (Date.now() - tapStart < 220) closeAccountModal();
        }, { passive: true });
      }
      async function logout() {
        if (dataInterval) {
          clearInterval(dataInterval);
          dataInterval = null;
        }
        if (timerInterval) {
          clearInterval(timerInterval);
          timerInterval = null;
        }

        const tokenToRevoke = currentToken;
        currentID = null;
        currentToken = null;
        userReservations = {};
        userActiveLeases = {};
        pendingReservationRequests = new Set();
        pendingReserveBookNo = null;
        latestBooksByCode = {};
        allCollectionOrder = [];
        categoryCollectionOrder = {};

        localStorage.removeItem("lbas_id");
        localStorage.removeItem("lbas_token");
        updateAuthMenus();

        if (tokenToRevoke) {
          try {
            await fetch("/api/logout", { method: "POST", headers: { Authorization: tokenToRevoke } });
          } catch (_error) {
            console.warn("Unable to contact logout endpoint.");
          }
        }

        document.getElementById("portalSection").style.display = "none";
        document.getElementById("loginSection").style.display = "flex";
        setStudentLoginStep("welcome");
        closeAccountModal();
        document.getElementById("bookContainer").innerHTML = "";
        
      }

      function initializeLBAS() {
        if (lbasInitialized) return;
        lbasInitialized = true;

        setStudentLoginStep("welcome");
        initStudentLoginSwipe();
        const leaderboardModalElement = document.getElementById("leaderboardProfileModal");
        if (window.bootstrap?.Modal && leaderboardModalElement) {
          leaderboardProfileModal = new window.bootstrap.Modal(leaderboardModalElement);
        } else {
          leaderboardProfileModal = null;
          console.warn("[LBAS] Bootstrap modal unavailable. Leaderboard profile modal is disabled.");
        }

        document.getElementById("bookContainer")?.addEventListener("click", (event) => {
          const button = event.target.closest(".reserve-book-btn");
          if (!button) return;
          if (button.getAttribute("onclick")) return;
          reserveBook(String(button.dataset.bookNo || "").trim());
        });

        document.addEventListener("click", (e) => {
          const categoryButton = e.target.closest(".category-btn");
          if (categoryButton?.dataset.category) {
            setCategoryFilter(categoryButton.dataset.category);
          }
        });
        document.getElementById("closeAccountBtn")?.addEventListener("click", closeAccountModal);
        document.getElementById("accountOverlay")?.addEventListener("click", closeAccountModal);
        attachAccountSwipeToClose();
        attachAccountTapToClose();
        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            closeAccountModal();
          }
        });

        fetchCategories();
        hydrateDisplaySettings();
        document.getElementById("loginSection").style.display = "none";
        document.getElementById("portalSection").style.display = "block";
        updateAuthMenus();
        document.getElementById("display_name").innerText = "Guest";
        document.getElementById("full_name").innerText = "Guest User";
        document.getElementById("id_val").innerText = "ID: -";
        document.getElementById("database_source").innerText = "CREDENTIAL: GUEST";
        document.getElementById("user_type_label").innerText = "PUBLIC ACCESS";
        document.getElementById("user_pic").src = "/Profile/default.png";
        switchPortalView("catalog");
        loadData();

        window.addEventListener("beforeunload", () => {
          if (!currentToken) return;
          fetch("/api/logout", {
            method: "POST",
            headers: { Authorization: currentToken },
            keepalive: true,
          });
        });

        const viewParam = new URLSearchParams(window.location.search).get("view");
        const reserveParam = new URLSearchParams(window.location.search).get("reserve");
        if (String(viewParam || "").toLowerCase() === "login") {
          document.getElementById("loginSection").style.display = "flex";
          document.getElementById("portalSection").style.display = "none";
          setStudentLoginStep("login");
        }
        if (String(viewParam || "").toLowerCase() === "signup") {
          toggleModal("registerModal", true);
        }
        if (reserveParam && isAuthenticatedUser()) {
          reserveBook(String(reserveParam).trim());
        }
      }

      document.addEventListener("DOMContentLoaded", function() {
        initializeLBAS();
      });


      document.getElementById('signUpLevelCollege')?.addEventListener('change', handleSignUpLevelChange);
      document.getElementById('signUpLevelHS')?.addEventListener('change', handleSignUpLevelChange);
      window.submitSignUp = submitSignUp;

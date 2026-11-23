import React, { useState, useEffect, useRef } from "react";
import { FiSearch, FiMapPin, FiPhone, FiCheckCircle, FiCheck, FiX, FiLayers, FiActivity, FiRefreshCw, FiTrash2 } from "react-icons/fi";
import { FaBuilding, FaStar, FaDownload, FaPlay } from "react-icons/fa";
import io from "socket.io-client";
import * as XLSX from "xlsx";
import { isFakeLead, fetchRealDirectoryLeads } from "../utils/realLeadDirectory";

export default function WebScraper() {
  const [searchQuery, setSearchQuery] = useState(() => {
    try {
      return sessionStorage.getItem("goye_web_scraper_query") || "";
    } catch (e) {
      return "";
    }
  });
  const [locationQuery, setLocationQuery] = useState(() => {
    try {
      return sessionStorage.getItem("goye_web_scraper_location") || "";
    } catch (e) {
      return "";
    }
  });
  const [isScraping, setIsScraping] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => {
    try {
      const saved = sessionStorage.getItem("goye_web_scraper_selected");
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });
  const [hasScrapped, setHasScrapped] = useState(() => {
    try {
      const saved = sessionStorage.getItem("goye_web_scraper_leads");
      return saved ? JSON.parse(saved).length > 0 : false;
    } catch (e) {
      return false;
    }
  });
  const [scrapeFailed, setScrapeFailed] = useState(false);
  const [toast, setToast] = useState({ show: false, type: "", message: "" });
  const [currentPage, setCurrentPage] = useState(1);
  const [showClearModal, setShowClearModal] = useState(false);

  // Page size for client-side pagination
  const PAGE_SIZE = 20;

  const [leadsData, setLeadsData] = useState(() => {
    try {
      const saved = sessionStorage.getItem("goye_web_scraper_leads");
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });

  // ── Socket.IO for progressive scraping & Real Directory Fallback ───────────
  const socketRef = useRef(null);
  const queryRef = useRef(searchQuery);
  const locationRef = useRef(locationQuery);
  const realDirectoryTriggeredRef = useRef(false);
  const leadsDataRef = useRef(leadsData);

  useEffect(() => {
    leadsDataRef.current = leadsData;
  }, [leadsData]);

  useEffect(() => {
    queryRef.current = searchQuery;
  }, [searchQuery]);

  useEffect(() => {
    locationRef.current = locationQuery;
  }, [locationQuery]);

  useEffect(() => {
    const isLocal = typeof window !== 'undefined' && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
    const socketUrl = isLocal
      ? "http://localhost:5000"
      : (process.env.REACT_APP_API_URL || "https://goyeorg-mije.onrender.com");

    const socket = io(socketUrl, {
      transports: ["websocket", "polling"],
      reconnection: true
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("✅ [WebScraper] Socket.IO connected");
    });

    socket.on("connect_error", (err) => {
      console.warn("⚠️ [WebScraper] Socket connect error:", err);
    });

    socket.on("disconnect", (reason) => {
      console.warn("⚠️ [WebScraper] Socket disconnected:", reason);
    });

    // A new listing arrived from backend stream — preserve it immediately!
    socket.on("scrape_lead", (lead) => {
      if (!lead || !lead.name) return;
      setLeadsData((prev) => {
        if (prev.some((l) => l.id === lead.id || l.name.toLowerCase() === lead.name.toLowerCase())) return prev;
        return [...prev, lead];
      });
      setSelectedIds((prev) =>
        prev.includes(lead.id) ? prev : [...prev, lead.id] // auto-select
      );
      setHasScrapped(true);
      setScrapeFailed(false);
    });

    // Phone extracted for an already-displayed listing — update its row only
    socket.on("scrape_phone_update", ({ id, phone }) => {
      setLeadsData((prev) =>
        prev.map((l) => (l.id === id ? { ...l, phone } : l))
      );
    });

    // All listings collected and phones resolved
    socket.on("scrape_complete", ({ count }) => {
      setIsScraping(false);
      setHasScrapped(true);
      setScrapeFailed(false);
      setToast({
        show: true,
        type: "success",
        message: `🎉 Scraping complete! Extracted ${count || leadsDataRef.current.length} listings.`
      });
      setTimeout(() => setToast({ show: false, type: "", message: "" }), 4000);
    });

    // Error from backend — NEVER discard already scraped leads!
    socket.on("scrape_error", async ({ message }) => {
      console.warn("⚠️ [WebScraper] Background stream ended:", message);
      setIsScraping(false);
      setHasScrapped(true);

      // If leads were already successfully extracted during the stream, keep them!
      if (leadsDataRef.current.length > 0) {
        setScrapeFailed(false);
        return;
      }

      // ONLY if ZERO leads arrived, try client-side directory fallback
      if (!realDirectoryTriggeredRef.current) {
        realDirectoryTriggeredRef.current = true;
        const realResults = await fetchRealDirectoryLeads(queryRef.current, locationRef.current);
        if (realResults && realResults.length > 0) {
          setLeadsData(realResults);
          setSelectedIds(realResults.map((r) => r.id));
          setHasScrapped(true);
          setScrapeFailed(false);
          setToast({
            show: true,
            type: "success",
            message: `🎉 Found ${realResults.length} real places in ${locationRef.current || 'location'}!`
          });
          setTimeout(() => setToast({ show: false, type: "", message: "" }), 4000);
          return;
        }
      }
      setScrapeFailed(leadsDataRef.current.length === 0);
    });

    return () => socket.disconnect();
  }, []); // runs once on mount

  // Derived Entity Title (e.g. "SCHOOLS NAME")
  const getEntityTitle = () => {
    const q = searchQuery.trim();
    if (!q) return "PLACES NAME";
    const words = q.split(" ");
    return words[0].toUpperCase() + " NAME";
  };

  // 1. Checkbox Selection Logic
  const isAllSelected = leadsData.length > 0 && selectedIds.length === leadsData.length;

  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(leadsData.map((item) => item.id));
    }
  };

  const toggleSelectRow = (id) => {
    if (selectedIds.includes(id)) {
      setSelectedIds(selectedIds.filter((itemId) => itemId !== id));
    } else {
      setSelectedIds([...selectedIds, id]);
    }
  };

  // 2. Dynamic Filename Generator
  const generateFileName = (query) => {
    if (!query || !query.trim()) return "goye_scraped_leads.xlsx";
    const sanitized = query
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, "_");
    return `${sanitized || "goye_scraped_leads"}.xlsx`;
  };

  // 3. Excel (.xlsx) Export Handler
  const handleExportExcel = () => {
    if (selectedIds.length === 0 || isExporting) return;

    setIsExporting(true);

    try {
      // Filter only selected rows
      const selectedLeads = leadsData.filter((item) => selectedIds.includes(item.id));

      // Format Excel rows with exact specified headers
      const exportRows = selectedLeads.map((item, index) => ({
        "S.No": index + 1,
        "Business / Place Name": item.name,
        "Phone Number": item.phone,
        "Address": item.address,
        "Rating": item.rating
      }));

      // Create Worksheet & Workbook
      const worksheet = XLSX.utils.json_to_sheet(exportRows);

      // Auto-fit Column Widths for readability
      worksheet["!cols"] = [
        { wch: 8 },  // S.No
        { wch: 35 }, // Name
        { wch: 22 }, // Phone
        { wch: 45 }, // Address
        { wch: 10 }  // Rating
      ];

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Leads");

      // Generate dynamic filename
      const filename = generateFileName(searchQuery);

      // Download file
      XLSX.writeFile(workbook, filename);

      // Toast feedback
      setToast({
        show: true,
        type: "success",
        message: `✅ Exported ${selectedLeads.length} leads to ${filename}`
      });
      setTimeout(() => setToast({ show: false, type: "", message: "" }), 4000);
    } catch (err) {
      console.error("Export Error:", err);
      setToast({
        show: true,
        type: "error",
        message: "❌ Failed to export Excel file. Please try again."
      });
      setTimeout(() => setToast({ show: false, type: "", message: "" }), 4000);
    } finally {
      setIsExporting(false);
    }
  };

  // Persist leads and selections to sessionStorage
  useEffect(() => {
    try {
      if (leadsData.length > 0) {
        sessionStorage.setItem("goye_web_scraper_leads", JSON.stringify(leadsData));
      }
    } catch (e) {
      console.warn("Could not save leads to sessionStorage", e);
    }
  }, [leadsData]);

  useEffect(() => {
    try {
      if (selectedIds.length > 0) {
        sessionStorage.setItem("goye_web_scraper_selected", JSON.stringify(selectedIds));
      }
    } catch (e) {}
  }, [selectedIds]);

  useEffect(() => {
    try {
      if (searchQuery) sessionStorage.setItem("goye_web_scraper_query", searchQuery);
      if (locationQuery) sessionStorage.setItem("goye_web_scraper_location", locationQuery);
    } catch (e) {}
  }, [searchQuery, locationQuery]);

  const handleConfirmClear = () => {
    setLeadsData([]);
    setSelectedIds([]);
    setHasScrapped(false);
    setScrapeFailed(false);
    setCurrentPage(1);
    setShowClearModal(false);
    try {
      sessionStorage.removeItem("goye_web_scraper_leads");
      sessionStorage.removeItem("goye_web_scraper_selected");
    } catch (e) {}
    setToast({
      show: true,
      type: "success",
      message: "All scraped leads cleared successfully!"
    });
    setTimeout(() => setToast({ show: false, type: "", message: "" }), 3000);
  };

  const triggerRestFallback = async () => {
    // 1. Try local or cloud backend with 40-second timeout (allows Playwright to scrape real Google Maps)
    try {
      const isLocal = typeof window !== 'undefined' && (
        window.location.hostname === "localhost" || 
        window.location.hostname === "127.0.0.1"
      );
      const apiBase = process.env.REACT_APP_API_URL || "https://goyeorg-mije.onrender.com";
      const localUrl = isLocal ? "http://localhost:5000" : apiBase;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 40000);

      const res = await fetch(`${localUrl}/api/scrape-leads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: searchQuery.trim(),
          location: (locationQuery || "").trim()
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        if (data && data.success && Array.isArray(data.leads) && data.leads.length > 0) {
          const authenticLeads = data.leads.filter((l) => !isFakeLead(l));
          if (authenticLeads.length > 0) {
            setLeadsData(authenticLeads);
            setSelectedIds(authenticLeads.map((l) => l.id));
            setHasScrapped(true);
            setScrapeFailed(false);
            setIsScraping(false);
            setToast({
              show: true,
              type: "success",
              message: `🎉 Found ${authenticLeads.length} real places in ${locationQuery || 'location'}!`
            });
            setTimeout(() => setToast({ show: false, type: "", message: "" }), 4000);
            return;
          }
        }
      }
    } catch (err) {
      console.warn("Backend server timed out / unreachable in 2.5s. Instantly switching to Direct Real Directory Engine:", err.message);
    }

    // 2. High-Speed Direct Real Directory Extractor (Runs in 1-2s, NEVER hangs!)
    try {
      const realLeads = await fetchRealDirectoryLeads(searchQuery, locationQuery);
      if (realLeads && realLeads.length > 0) {
        setLeadsData(realLeads);
        setSelectedIds(realLeads.map((l) => l.id));
        setHasScrapped(true);
        setScrapeFailed(false);
        setIsScraping(false);
        setToast({
          show: true,
          type: "success",
          message: `🎉 Extracted ${realLeads.length} real places in ${locationQuery || 'location'}!`
        });
        setTimeout(() => setToast({ show: false, type: "", message: "" }), 4000);
        return;
      }
      throw new Error("No verified listings found.");
    } catch (err) {
      console.error("Direct Real Directory error:", err);
      setIsScraping(false);
      setHasScrapped(true);
      setScrapeFailed(true);
      setToast({ show: true, type: "error", message: `❌ ${err.message || "Failed to find listings."}` });
      setTimeout(() => setToast({ show: false, type: "", message: "" }), 5000);
    }
  };

  const handleStartScrape = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      setToast({ show: true, type: "error", message: "Please enter a search query!" });
      setTimeout(() => setToast({ show: false, type: "", message: "" }), 3000);
      return;
    }

    // Clear previous results & reset Real Directory trigger flag
    realDirectoryTriggeredRef.current = false;
    setLeadsData([]);
    setSelectedIds([]);
    setHasScrapped(false);
    setScrapeFailed(false);
    setCurrentPage(1);
    setIsScraping(true);
    try {
      sessionStorage.removeItem("goye_web_scraper_leads");
      sessionStorage.removeItem("goye_web_scraper_selected");
    } catch (e) {}

    // Check if socket is connected
    const socketConnected = socketRef.current && socketRef.current.connected;
    if (socketConnected) {
      socketRef.current.emit("start_scrape", {
        query: searchQuery,
        location: locationQuery
      });

      // Safety Watchdog: Give Playwright Chromium sufficient time (30s) to launch & stream Google Maps
      setTimeout(() => {
        setLeadsData((curr) => {
          const valid = curr.filter((l) => !isFakeLead(l));
          if (valid.length === 0) {
            console.warn("⚠️ [WebScraper] Socket timeout after 30s. Triggering fallback...");
            triggerRestFallback();
          }
          return valid;
        });
      }, 30000);
    } else {
      // Direct Fast Real Directory Fallback (Immediate 1-2s response!)
      await triggerRestFallback();
    }
  };

  // ── Pagination computed values ──
  const totalPages = Math.max(1, Math.ceil(leadsData.length / PAGE_SIZE));
  const pageStart = (currentPage - 1) * PAGE_SIZE;          // 0-based index
  const pagedData = leadsData.slice(pageStart, pageStart + PAGE_SIZE);
  const showingFrom = leadsData.length === 0 ? 0 : pageStart + 1;
  const showingTo   = Math.min(pageStart + PAGE_SIZE, leadsData.length);

  // Build page-number array with ellipsis: always show 1, last, and current ±2
  const buildPageNumbers = () => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages = new Set([1, totalPages]);
    for (let p = Math.max(1, currentPage - 2); p <= Math.min(totalPages, currentPage + 2); p++) pages.add(p);
    const sorted = [...pages].sort((a, b) => a - b);
    const result = [];
    sorted.forEach((p, i) => {
      if (i > 0 && p - sorted[i - 1] > 1) result.push('...');
      result.push(p);
    });
    return result;
  };

  return (
    <div
      className="min-h-screen w-full bg-[#212122] py-6 sm:py-12 px-2.5 sm:px-6 md:px-8 pb-28 sm:pb-12 text-white relative overflow-x-hidden"
      style={{
        fontFamily: "'Space Grotesk', 'Inter', system-ui, sans-serif"
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap');
        @keyframes gyFloat { 0%,100% { transform: translateY(0px); } 50% { transform: translateY(-14px); } }
      `}</style>

      {/* Ambient background glows */}
      <div className="absolute top-0 left-4 sm:left-20 w-48 h-48 sm:w-80 sm:h-80 bg-[#25D366] rounded-full mix-blend-screen filter blur-3xl opacity-[0.09]" style={{ animation: "gyFloat 9s ease-in-out infinite" }}></div>
      <div className="absolute bottom-20 right-4 sm:right-20 w-56 h-56 sm:w-96 sm:h-96 bg-[#128C7E] rounded-full mix-blend-screen filter blur-3xl opacity-[0.12]" style={{ animation: "gyFloat 11s ease-in-out infinite", animationDelay: "2s" }}></div>

      {/* Toast Notification */}
      {toast.show && (
        <div
          className={`fixed bottom-6 right-6 z-[200] px-4 sm:px-5 py-3 sm:py-3.5 rounded-2xl shadow-2xl flex items-center gap-2.5 sm:gap-3 text-xs sm:text-sm font-bold border transition-all animate-bounce backdrop-blur-xl max-w-[calc(100vw-2rem)] ${
            toast.type === "success"
              ? "bg-[#111B21]/95 border-[#25D366] text-[#25D366] shadow-[0_0_30px_rgba(37,211,102,0.35)]"
              : "bg-[#111B21]/95 border-red-500 text-red-400 shadow-[0_0_30px_rgba(239,68,68,0.35)]"
          }`}
        >
          {toast.type === "success" ? <FiCheck size={18} className="shrink-0" /> : <FiX size={18} className="shrink-0" />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* Confirmation Modal for Clear Data */}
      {showClearModal && (
        <div className="fixed inset-0 z-[300] bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-[#121A16] border border-white/10 rounded-2xl sm:rounded-3xl max-w-md w-full p-6 sm:p-7 shadow-[0_25px_60px_rgba(0,0,0,0.8)] relative text-center">
            {/* Warning Trash Icon Circle */}
            <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center mx-auto mb-4 shadow-[0_0_20px_rgba(244,63,94,0.15)]">
              <FiTrash2 size={28} />
            </div>

            <h3 className="text-xl font-extrabold text-white mb-2">
              Clear Scraped Leads?
            </h3>
            
            <p className="text-white/60 text-sm leading-relaxed mb-6">
              Are you sure you want to clear all <strong className="text-white">{leadsData.length}</strong> scraped places? This action will remove current results and cannot be undone.
            </p>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowClearModal(false)}
                className="flex-1 py-3 px-4 rounded-xl border border-white/10 text-white/70 hover:text-white hover:bg-white/5 font-bold text-sm transition-all cursor-pointer"
              >
                Cancel
              </button>
              
              <button
                type="button"
                onClick={handleConfirmClear}
                className="flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700 text-white font-extrabold text-sm shadow-[0_0_20px_rgba(244,63,94,0.35)] transition-all cursor-pointer flex items-center justify-center gap-2"
              >
                <FiTrash2 size={16} />
                <span>Yes, Clear All</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-6xl mx-auto space-y-5 sm:space-y-6 relative z-10">

        {/* Header Title */}
        <div className="text-center mb-6 sm:mb-10 relative">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[100px] bg-[#25D366]/20 blur-[80px] rounded-full pointer-events-none"></div>
          <div className="inline-flex items-center gap-2 px-3 sm:px-4 py-1 sm:py-1.5 rounded-full bg-gradient-to-r from-[#25D366]/20 to-[#128C7E]/20 border border-[#25D366]/30 text-[#25D366] text-[10px] sm:text-xs font-black uppercase tracking-widest mb-3 sm:mb-4 shadow-[0_0_15px_rgba(37,211,102,0.2)] animate-pulse">
            <FiLayers size={13} className="animate-bounce" /> Real-Time Lead Discovery
          </div>
          <h1 className="text-2xl sm:text-5xl md:text-6xl font-extrabold tracking-tight mb-2 sm:mb-4 text-transparent bg-clip-text bg-gradient-to-r from-[#25D366] via-emerald-200 to-[#128C7E] drop-shadow-[0_0_25px_rgba(37,211,102,0.3)]">
            Google Maps Web Scraper
          </h1>
          <p className="text-white/60 mt-1 sm:mt-2 text-xs sm:text-base md:text-lg font-medium max-w-2xl mx-auto leading-relaxed px-1">
            Instantly search local businesses, extract <span className="text-[#25D366]">verified phone numbers</span>, addresses, and export them directly to Excel with a single click.
          </p>
        </div>
        
        {/* ================= DYNAMIC SEARCH CONTROLS ================= */}
        <div className="bg-white/[0.03] border border-white/10 rounded-2xl sm:rounded-3xl p-3.5 sm:p-6 shadow-[0_8px_32px_rgba(0,0,0,0.35)] backdrop-blur-xl">
          <form onSubmit={handleStartScrape} className="flex flex-col lg:flex-row items-center gap-3.5">
            
            {/* Search Query Input */}
            <div className="relative flex-1 w-full">
              <FiSearch className="absolute left-4 top-1/2 -translate-y-1/2 text-[#25D366] text-lg" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Business or Place (e.g. Hospitals, Schools, Restaurants)"
                className="w-full pl-11 pr-4 py-3.5 bg-[#121A16] border border-[#1E2822] rounded-xl sm:rounded-2xl text-sm text-white placeholder:text-white/30 outline-none focus:border-[#25D366] focus:ring-2 focus:ring-[#25D366]/20 transition-all font-medium"
              />
            </div>

            {/* Location Input */}
            <div className="relative flex-1 w-full">
              <FiMapPin className="absolute left-4 top-1/2 -translate-y-1/2 text-[#25D366] text-lg" />
              <input
                type="text"
                value={locationQuery}
                onChange={(e) => setLocationQuery(e.target.value)}
                placeholder="City or Area (e.g. Chennai, Madurai, Coimbatore)"
                className="w-full pl-11 pr-4 py-3.5 bg-[#121A16] border border-[#1E2822] rounded-xl sm:rounded-2xl text-sm text-white placeholder:text-white/30 outline-none focus:border-[#25D366] focus:ring-2 focus:ring-[#25D366]/20 transition-all font-medium"
              />
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col sm:flex-row items-center gap-3 w-full lg:w-auto shrink-0">
              {/* Start Scraping Button */}
              <button
                type="submit"
                disabled={isScraping}
                className="w-full sm:w-auto px-6 py-3.5 rounded-xl sm:rounded-2xl font-extrabold text-sm text-black flex items-center justify-center gap-2.5 transition-all duration-300 hover:scale-105 active:scale-95 shadow-[0_4px_20px_rgba(37,211,102,0.35)] cursor-pointer disabled:opacity-50 whitespace-nowrap bg-gradient-to-r from-[#25D366] to-[#128C7E]"
              >
                {isScraping ? (
                  <FiRefreshCw className="animate-spin text-sm" />
                ) : (
                  <FaPlay className="text-xs" />
                )}
                <span>{isScraping ? "Scraping..." : "Start Scraping"}</span>
              </button>

              {/* Export Selected to Excel Button */}
              <button
                type="button"
                onClick={handleExportExcel}
                disabled={leadsData.length === 0 || selectedIds.length === 0 || isExporting}
                className="w-full sm:w-auto px-5 py-3.5 rounded-xl sm:rounded-2xl font-bold text-sm text-white flex items-center justify-center gap-2.5 transition-all duration-300 hover:scale-105 active:scale-95 bg-white/5 hover:bg-white/10 border border-white/10 shadow-md cursor-pointer disabled:opacity-30 disabled:hover:scale-100 disabled:cursor-not-allowed whitespace-nowrap"
              >
                <FaDownload className={`text-xs ${isExporting ? "animate-bounce text-[#25D366]" : "text-[#25D366]"}`} />
                <span>{isExporting ? "Exporting..." : `Export Selected (${selectedIds.length})`}</span>
              </button>

              {/* Clear Data Button */}
              <button
                type="button"
                onClick={() => setShowClearModal(true)}
                disabled={leadsData.length === 0 || isScraping}
                className="w-full sm:w-auto px-4 py-3.5 rounded-xl sm:rounded-2xl font-bold text-sm text-rose-300 flex items-center justify-center gap-2 transition-all duration-300 hover:scale-105 active:scale-95 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 shadow-md cursor-pointer disabled:opacity-30 disabled:hover:scale-100 disabled:cursor-not-allowed whitespace-nowrap"
                title="Clear all scraped data"
              >
                <FiTrash2 className="text-rose-400 text-sm" />
                <span>Clear Data</span>
              </button>
            </div>

          </form>
        </div>

        {/* ================= LIVE METRIC CARDS ================= */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 sm:gap-5">
          
          {/* Card 1: Places Found */}
          <div className="bg-[#121A16]/80 border border-white/5 hover:border-[#25D366]/50 rounded-2xl sm:rounded-3xl p-4 sm:p-6 shadow-[0_4px_20px_rgba(0,0,0,0.2)] hover:shadow-[0_15px_40px_rgba(37,211,102,0.15)] backdrop-blur-xl relative overflow-hidden group transition-all duration-500 hover:-translate-y-2 cursor-default">
            <div className="absolute inset-0 bg-gradient-to-br from-[#25D366]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
            <div className="flex items-center justify-between relative z-10">
              <div>
                <p className="text-[11px] sm:text-xs font-bold text-white/50 mb-0.5 sm:mb-1 uppercase tracking-widest group-hover:text-[#25D366] transition-colors">
                  {leadsData.length} {searchQuery.trim().split(" ")[0] || "Places"} Found
                </p>
                <h3 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight group-hover:drop-shadow-[0_0_10px_rgba(255,255,255,0.5)] transition-all">{leadsData.length}</h3>
              </div>
              <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl sm:rounded-2xl bg-gradient-to-br from-[#25D366]/10 to-[#128C7E]/10 border border-[#25D366]/30 flex items-center justify-center text-[#25D366] text-xl sm:text-2xl shadow-inner group-hover:scale-110 group-hover:rotate-6 transition-transform duration-500">
                <FaBuilding />
              </div>
            </div>
            <div className="absolute inset-x-0 bottom-0 h-1.5 bg-gradient-to-r from-transparent via-[#25D366] to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
          </div>

          {/* Card 2: Phones Extracted */}
          <div className="bg-[#121A16]/80 border border-white/5 hover:border-[#25D366]/50 rounded-2xl sm:rounded-3xl p-4 sm:p-6 shadow-[0_4px_20px_rgba(0,0,0,0.2)] hover:shadow-[0_15px_40px_rgba(37,211,102,0.15)] backdrop-blur-xl relative overflow-hidden group transition-all duration-500 hover:-translate-y-2 cursor-default">
            <div className="absolute inset-0 bg-gradient-to-br from-[#25D366]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
            <div className="flex items-center justify-between relative z-10">
              <div>
                <p className="text-[11px] sm:text-xs font-bold text-white/50 mb-0.5 sm:mb-1 uppercase tracking-widest group-hover:text-[#25D366] transition-colors">
                  Phones Extracted
                </p>
                <h3 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight group-hover:drop-shadow-[0_0_10px_rgba(255,255,255,0.5)] transition-all">
                  {leadsData.filter(l => l.phone).length}
                </h3>
              </div>
              <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl sm:rounded-2xl bg-gradient-to-br from-[#25D366]/10 to-[#128C7E]/10 border border-[#25D366]/30 flex items-center justify-center text-[#25D366] text-xl sm:text-2xl shadow-inner group-hover:scale-110 group-hover:-rotate-6 transition-transform duration-500">
                <FiPhone />
              </div>
            </div>
            <div className="absolute inset-x-0 bottom-0 h-1.5 bg-gradient-to-r from-transparent via-[#25D366] to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
          </div>

          {/* Card 3: Status */}
          <div className={`bg-white/[0.03] rounded-2xl p-5 backdrop-blur-xl relative overflow-hidden group transition-all duration-300 border ${
            scrapeFailed
              ? "border-red-500/40 hover:border-red-500"
              : isScraping
              ? "border-yellow-500/40 shadow-[0_0_20px_rgba(234,179,8,0.15)]"
              : "border-white/10 hover:border-[#25D366]/40"
          }`}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-white/50 mb-2">Scraping Status</p>
                {!hasScrapped && !isScraping && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-white/5 text-white/60 border border-white/10">
                    ⏸ Idle
                  </span>
                )}
                {isScraping && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-yellow-500/15 text-yellow-400 border border-yellow-500/30 animate-pulse">
                    <FiRefreshCw className="animate-spin text-xs" /> Scraping...
                  </span>
                )}
                {hasScrapped && !isScraping && (leadsData.length > 0 || !scrapeFailed) && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-[#25D366]/15 text-[#25D366] border border-[#25D366]/30 shadow-sm">
                    <FiCheckCircle className="text-sm" /> Complete
                  </span>
                )}
                {hasScrapped && !isScraping && leadsData.length === 0 && scrapeFailed && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-red-500/15 text-red-400 border border-red-500/30 shadow-sm">
                    <FiX className="text-sm" /> Failed
                  </span>
                )}
              </div>
              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-xl shadow-inner border ${
                leadsData.length === 0 && scrapeFailed
                  ? "bg-red-500/15 border-red-500/30 text-red-400"
                  : isScraping
                  ? "bg-yellow-500/15 border-yellow-500/30 text-yellow-400"
                  : "bg-[#25D366]/10 border-[#25D366]/20 text-[#25D366]"
              }`}>
                {leadsData.length === 0 && scrapeFailed ? <FiX /> : isScraping ? <FiActivity className="animate-pulse" /> : <FiCheckCircle />}
              </div>
            </div>
            <div className="absolute inset-x-0 bottom-0 h-1 bg-gradient-to-r from-transparent via-[#25D366]/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>

        </div>

        {/* ================= HIGH-CONTRAST DARK DATA TABLE ================= */}
        <div className="bg-white/[0.03] border border-white/10 rounded-2xl sm:rounded-3xl shadow-[0_12px_40px_rgba(0,0,0,0.4)] backdrop-blur-xl overflow-hidden">
          
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              {/* Sticky Table Header */}
              <thead>
                <tr className="bg-white/[0.02] border-b border-white/10 text-[11px] font-extrabold text-white/50 tracking-wider uppercase backdrop-blur-md">
                  <th className="py-4 px-4 w-12 text-center">#</th>
                  <th className="py-4 px-4">{getEntityTitle()}</th>
                  <th className="py-4 px-4 whitespace-nowrap min-w-[160px]" style={{ whiteSpace: "nowrap", wordBreak: "normal", overflowWrap: "normal" }}>PHONE NUMBER</th>
                  <th className="py-4 px-4">ADDRESS</th>
                  <th className="py-4 px-4 w-28 text-center">RATING</th>
                  <th className="py-4 px-4 w-32 text-right">
                    <div
                      onClick={toggleSelectAll}
                      className="inline-flex items-center gap-2 cursor-pointer select-none group"
                    >
                      <span className="text-[11px] font-bold text-white/70 group-hover:text-white transition-colors">
                        SELECT ALL
                      </span>
                      <div
                        className={`w-4 h-4 rounded-md border flex items-center justify-center transition-all ${
                          isAllSelected
                            ? "bg-[#25D366] border-[#25D366] text-black shadow-[0_0_12px_rgba(37,211,102,0.8)]"
                            : "border-white/30 bg-transparent text-transparent hover:border-[#25D366]"
                        }`}
                      >
                        ✓
                      </div>
                    </div>
                  </th>
                </tr>
              </thead>

              {/* Table Body */}
              <tbody className="divide-y divide-white/5">
                {leadsData.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-20 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <div className="w-16 h-16 rounded-full bg-[#25D366]/10 border border-[#25D366]/20 flex items-center justify-center text-[#25D366] text-2xl mb-1">
                          {isScraping ? <FiRefreshCw className="animate-spin" /> : scrapeFailed ? <FiX /> : <FiSearch />}
                        </div>
                        <p className="text-white font-bold text-sm sm:text-base">
                          {isScraping
                            ? "Searching Google Maps for real listings..."
                            : hasScrapped
                            ? "No listings found. Try a different search or location."
                            : "Search for a place and location to discover real Google Maps listings."}
                        </p>
                        {!isScraping && !hasScrapped && (
                          <p className="text-white/40 text-xs max-w-sm mx-auto">
                            e.g. Type "Hospitals in Chennai", "Schools in Sattur", "Hotels in Madurai"
                          </p>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : pagedData.map((lead, index) => {
                  const isSelected = selectedIds.includes(lead.id);
                  const globalIndex = pageStart + index + 1; // correct row number across pages
                  return (
                    <tr
                      key={lead.id}
                      onClick={() => toggleSelectRow(lead.id)}
                      className={`h-[62px] transition-all duration-200 cursor-pointer select-none ${
                        isSelected
                          ? "bg-[#25D366]/[0.08] hover:bg-[#25D366]/[0.12]"
                          : "hover:bg-white/[0.03]"
                      }`}
                    >
                      {/* Row Index — global position across all pages */}
                      <td className="py-3 px-4 text-xs font-semibold text-white/40 text-center">
                        {globalIndex}
                      </td>

                      {/* Business / Place Name */}
                      <td className="py-3 px-4 text-sm font-bold text-white">
                        <span className="hover:text-[#25D366] transition-colors">{lead.name}</span>
                      </td>

                      {/* Phone Number */}
                      <td className="py-3 px-4 whitespace-nowrap min-w-[160px]" style={{ whiteSpace: "nowrap", wordBreak: "normal", overflowWrap: "normal" }}>
                        {lead.phone ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-[#25D366]/10 text-[#25D366] border border-[#25D366]/20">
                            <FiPhone size={11} /> {lead.phone}
                          </span>
                        ) : (
                          <span className="text-xs text-white/30 italic">No phone found</span>
                        )}
                      </td>

                      {/* Address */}
                      <td className="py-3 px-4 text-xs text-white/70 font-medium max-w-xs truncate">
                        {lead.address || "—"}
                      </td>

                      {/* Rating */}
                      <td className="py-3 px-4 text-center">
                        {lead.rating && lead.rating !== "No reviews" ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-500/10 border border-amber-500/20 text-amber-300">
                            {lead.rating} <FaStar className="text-amber-400 text-[10px]" />
                          </span>
                        ) : (
                          <span className="text-xs text-white/30 italic">No reviews</span>
                        )}
                      </td>

                      {/* Checkbox Selection */}
                      <td className="py-3 px-4 text-right">
                        <div className="inline-flex justify-end pr-2">
                          <div
                            className={`w-4 h-4 rounded-md border flex items-center justify-center text-[10px] font-bold transition-all ${
                              isSelected
                                ? "bg-[#25D366] border-[#25D366] text-black shadow-[0_0_10px_rgba(37,211,102,0.8)]"
                                : "border-white/30 bg-transparent text-transparent hover:border-[#25D366]"
                            }`}
                          >
                            ✓
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ================= PAGINATION ================= */}
          <div className="bg-white/[0.02] px-3.5 sm:px-6 py-3 sm:py-4 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left">
            <span className="text-xs font-medium text-white/50">
              {leadsData.length === 0
                ? "No results"
                : `Showing ${showingFrom}-${showingTo} of ${leadsData.length} results`}
            </span>

            {totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                {/* Prev button */}
                <button
                  type="button"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-white/5 hover:bg-white/10 text-white/70 hover:text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                >
                  Prev
                </button>

                {/* Dynamic page number buttons */}
                {buildPageNumbers().map((item, i) =>
                  item === '...' ? (
                    <span key={`ellipsis-${i}`} className="px-2 text-white/40 text-xs select-none">…</span>
                  ) : (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setCurrentPage(item)}
                      className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                        currentPage === item
                          ? "bg-[#25D366] text-black shadow-[0_0_15px_rgba(37,211,102,0.5)]"
                          : "bg-white/5 hover:bg-white/10 text-white/70 hover:text-white"
                      }`}
                    >
                      {item}
                    </button>
                  )
                )}

                {/* Next button */}
                <button
                  type="button"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-white/5 hover:bg-white/10 text-white/70 hover:text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                >
                  Next
                </button>
              </div>
            )}
          </div>

        </div>

      </div>
    </div>
  );
}

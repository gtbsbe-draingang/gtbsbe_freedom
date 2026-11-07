// The form script of the mock Dynamics form. A real one runs on the form's OnLoad and reaches the
// web resource through the control's getContentWindow(); this does the same with a fake Xrm and a
// fake formContext, so the hand-over is exercised exactly as Dynamics would do it.
(function () {
  "use strict";

  var FIELD = "cqa_conversationid";
  var frame = document.querySelector("[data-test='cqa-frame']");
  var status = document.querySelector("[data-test='handover-status']");
  var recordId = document.querySelector("[data-test='record-field']").textContent.trim();

  var fakeXrm = {
    Utility: {
      getGlobalContext: function () {
        return { userSettings: { userName: "Demo user", languageId: 1049 } };
      },
    },
  };

  var fakeFormContext = {
    getAttribute: function (name) {
      return name === FIELD ? { getValue: function () { return recordId; } } : null;
    },
    getControl: function (name) {
      if (name !== "WebResource_cqa") return null;
      return { getContentWindow: function () { return Promise.resolve(frame.contentWindow); } };
    },
  };

  var done = false;
  function handOver() {
    if (done) return;
    fakeFormContext.getControl("WebResource_cqa").getContentWindow().then(function (win) {
      if (done || !win || !win.CQA || typeof win.CQA.setClientApiContext !== "function") return;
      done = true;
      win.CQA.setClientApiContext(fakeXrm, fakeFormContext);
      status.textContent = "Форма передала контекст: " + FIELD + " = " + recordId + ".";
    });
  }

  frame.addEventListener("load", handOver);
  handOver(); // the frame may have finished loading before this script ran
})();

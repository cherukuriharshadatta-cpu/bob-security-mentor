(function (global) {
  "use strict";

  function text(value) { return String(value == null ? "" : value).replace(/\s+/g, " ").trim(); }
  function element(documentRef, tag, className, value) {
    var node = documentRef.createElement(tag);
    node.className = className;
    if (value) node.textContent = value;
    return node;
  }

  function render(target, response) {
    if (!target || !target.ownerDocument || !response || response.untrusted !== true) return false;
    var documentRef = target.ownerDocument;
    target.textContent = "";
    target.setAttribute("data-bob-untrusted", "true");
    var card = element(documentRef, "section", "bob-mentor-card");
    card.setAttribute("aria-label", "Bob mentor review, untrusted guidance");
    card.appendChild(element(documentRef, "strong", "bob-mentor-card__badge", "BOB · REVIEW ONLY · UNTRUSTED"));
    var reply = text(response.reply);
    if (reply) card.appendChild(element(documentRef, "p", "bob-mentor-card__reply", reply));
    if (response.nextStep && text(response.nextStep.text)) {
      card.appendChild(element(documentRef, "h3", "bob-mentor-card__heading", "Suggested next step"));
      card.appendChild(element(documentRef, "p", "bob-mentor-card__next", text(response.nextStep.text)));
    }
    if (response.lesson && (text(response.lesson.title) || text(response.lesson.text))) {
      card.appendChild(element(documentRef, "h3", "bob-mentor-card__heading", text(response.lesson.title) || "Lesson"));
      card.appendChild(element(documentRef, "p", "bob-mentor-card__lesson", text(response.lesson.text)));
    }
    var checks = Array.isArray(response.verificationNeeded) ? response.verificationNeeded : [];
    if (checks.length) {
      card.appendChild(element(documentRef, "h3", "bob-mentor-card__heading", "Human checks to consider"));
      var list = element(documentRef, "ul", "bob-mentor-card__checks");
      checks.slice(0, 20).forEach(function (check) {
        var item = element(documentRef, "li", "bob-mentor-card__check", text(check.text || check));
        list.appendChild(item);
      });
      card.appendChild(list);
    }
    card.appendChild(element(documentRef, "p", "bob-mentor-card__limit", "Bob did not run tests, inspect code, change files, or prove readiness."));
    target.appendChild(card);
    return true;
  }

  global.BobMentorCard = Object.freeze({ render: render });
}(typeof window !== "undefined" ? window : globalThis));

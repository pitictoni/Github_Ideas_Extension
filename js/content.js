//Listen for messages from the popup
//TODO
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "smt") {
    
    sendResponse({ status: "done" });
  }
});

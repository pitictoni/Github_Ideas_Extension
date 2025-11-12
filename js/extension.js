
document.getElementById('showPopup').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: showInjectedPopup
    });
  });
});

function showInjectedPopup() {
  const popup = document.createElement("div");
  popup.id = "myExtensionPopup";
  popup.innerHTML = `
    <div style="
      position: fixed;
      top: 20%;
      left: 50%;
      transform: translateX(-50%);
      background: white;
      border: 1px solid #ccc;
      border-radius: 12px;
      padding: 10px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      z-index: 999999;
      width: 30%;
      height: 30%;
      cursor: move;
    ">
      <div id="popupHeader" style="padding: 10px; cursor: move;">
        <h6 style="color: black">Notes</h6>
      </div>
      <textarea style="
        width: 100%; 
        height: 70%; 
        border: 1px solid black; 
        outline: none; 
        resize: none; 
        background-color: 
        white; color: black;
      "></textarea>
      <div style="display: flex; padding: 10px; justify-content: space-between">
        <button style="color: black" type="button" class="btn">History</button>
        <button style="color: black" type="button" class="btn">Commit</button>
      </div>
    </div>
    
  `;
  document.body.appendChild(popup);

  const el = popup.querySelector("div");
  const header = popup.querySelector("#popupHeader");
  dragElement(el, header);

  function dragElement(elmnt, dragHandle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

    dragHandle.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
      e.preventDefault();
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;
      elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
      elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
    }

    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
    }
  }
}




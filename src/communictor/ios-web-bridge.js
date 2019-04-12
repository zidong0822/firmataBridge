const IOSWebBridge = () => {
    return {
        setupWKWebViewJavascriptBridge: function(callback) {
            if (window.WKWebViewJavascriptBridge) {
                return callback(WKWebViewJavascriptBridge)
            }
            if (window.WKWVJBCallbacks) {
                return window.WKWVJBCallbacks.push(callback)
            }
            window.WKWVJBCallbacks = [callback]
            window.webkit.messageHandlers.iOS_Native_InjectJavascript.postMessage(null)
        }
    }
}
export default new IOSWebBridge()

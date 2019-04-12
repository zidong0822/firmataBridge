import iosWebBridge from './ios-web-bridge'
let instance = null
let msgReceiver = null
let connected = false
class BleComm {
    constructor () {
        if (!instance) {
            instance = this
        }
        iosWebBridge.setupWKWebViewJavascriptBridge(bridge => {
            bridge.registerHandler('handleNotification', data => {
                this.handleNotification(data)
            })
        })
        return instance
    }

    isConnected () {
        return connected
    }

    setReceiver (receiver) {
        msgReceiver = receiver
    }

    sendMsgPromise (data) {
        return new Promise((resolve) => {
            iosWebBridge.setupWKWebViewJavascriptBridge(function(bridge) {
                bridge.callHandler('sendMsgPromise', { 'data': data }, function (response) {
                    console.log('JS got response', response)
                    resolve()
                })
            })
        })
    }

    connect () {
        console.log('connect')
        return new Promise((resolve,reject) => {
            iosWebBridge.setupWKWebViewJavascriptBridge(function(bridge) {
                console.log('bridge call connect')
                bridge.callHandler('bleConnect', { 'foo': 'bar' }, function (response) {
                    console.log('JS got response', response)
                    if(response === "success"){
                        connected = true
                        resolve(response)
                    }else{
                        reject(new Error('No connection'))
                    }
                })
            })
        })
    }

    handleNotification (data) {
        if (msgReceiver && this.isConnected() === true) {
            console.log("data",data.data)
            msgReceiver(data.data)
        }
    }

    disconnect () {
        console.log('ios-disconnect')
        connected = false
        return new Promise((resolve) => {
            iosWebBridge.setupWKWebViewJavascriptBridge(function(bridge) {
                bridge.callHandler('bleDisConnect', { 'foo': 'bar' }, function (response) {
                    console.log('JS got response', response)
                    resolve(response)
                })
            })
        })
    }
    getDevices () {
        return [{ commName: 'ble_mobile', commType: 'ble_mobile' }]
    }
}

export default new BleComm()

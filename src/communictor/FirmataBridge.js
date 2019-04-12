import communicator from './communicator.js'
import Firmata from './firmata.js'
import iosWebBridge from './ios-web-bridge.js'
let instance = null
class FirmataBridge {
    constructor() {
        if (!instance) {
            instance = this
            instance.registerFirmata()
            instance.registerBridge()
        }
        return instance
    }

    registerFirmata() {
        this.firmata = new Firmata(communicator)
        this.firmata.getPinsForMode()
        this.firmata.on('ready', () => {
            console.log('Ready indicator')
            this.callWkWebViewBridge('connectReady')
        })
        this.firmata.on('disconnect', () => {
            console.log('disconnect indicator')
            this.callWkWebViewBridge('disconnect')
        })
        this.firmata.on('timeout', () => {
            console.log('timeout')
            this.callWkWebViewBridge('connectTimeOut')
        })
        this.firmata.on('versionExpired',()=> {
            console.log('versionExpired')
            this.callWkWebViewBridge('versionExpired')
        })
    }


    callWkWebViewBridge(functionName) {
        iosWebBridge.setupWKWebViewJavascriptBridge(function (bridge) {
            bridge.callHandler(functionName, null, null)
        })
    }

    registerBridge() {
        console.log('registerBridge')
        iosWebBridge.setupWKWebViewJavascriptBridge(bridge => {
            bridge.registerHandler('deviceConnect', (response) => {
                console.log('deviceConnect')
                this.refreshPort()
            })
        })
        iosWebBridge.setupWKWebViewJavascriptBridge(bridge => {
            bridge.registerHandler('deviceDisConnect', () => {
                this.disConnectDevice()
            })
        })

        iosWebBridge.setupWKWebViewJavascriptBridge(bridge => {
            bridge.registerHandler('firmataControl',(control)=>{
                console.log('data',control)
                this.firmata[`${control.name}`](...control.param)
            })
        })

    }

    refreshPort() {
        // iosWebBridge.setupWKWebViewJavascriptBridge(function (bridge) {
        //     bridge.callHandler("bleConnect", null, null)
        // })
        const devList = []
        communicator.getDeviceList().then(data => {
            data.forEach(devices => {
                devices.forEach(device => {
                    if (device.commType === 'ble_mobile') {
                        communicator.connect(device)
                    }
                    devList.push(device)
                })
            })
        }, _ => {
        })
    }

    disConnectDevice() {
        communicator.disconnect()
    }
}
export default FirmataBridge
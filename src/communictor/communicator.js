
import bleComm from './iosBleComm'
import Emitter from  'events'
let instance = null

class Communicator extends Emitter {
    constructor () {
        super()
        if (!instance) {
            instance = this
        }
        return instance
    }

    setCommunicator (communicator) {
        this.communicator = communicator
    }

    msgReceiver (data, isError) {
        console.log("msgReceiver",isError)
        if (isError) {
            this.disconnect()
        } else {
            console.log("emit data",data)
            this.emit('data', data)
        }
    }

    write (data) {
        if (this.communicator) {
            return this.sendMsgPromise(data)
        }
    }


    sendMsgPromise (data) {
        if (this.communicator) {
            console.log("sendMsgPromise",data)
            return this.communicator.sendMsgPromise(data)
        }
        return Promise.reject(new Error('No connection'))
    }


    getDeviceList () {
        console.log("getDeviceList")
        return Promise.all([bleComm.getDevices()])
    }

    disconnect () {
        console.log("disconnect")
        if (!this.currentDevice) {
            return new Promise(resolve => {
                resolve()
            })
        }

        if (this.currentDevice.commType === 'ble_mobile') {
            bleComm.setReceiver(null)
            this.currentDevice = null
            this.emit('disconnect')
            return bleComm.disconnect()
        }
    }
    connect (device, currentDevice) {
        console.log("connect",device)
        return this.connectInternal(device, currentDevice).then(ret => new Promise((resolve, reject) => {
            this.emit('open')
            console.log("12321321312312312321312312")
            setTimeout(() => {
                resolve(ret)
            }, 200)
        })).catch((error)=>{
            console.log("errrro1111111",error)
        })
    }
    connectInternal (device) {
        console.log("connectInternal",device)
        this.currentDevice = device
        if (device.commType === 'ble_mobile') {
            this.setCommunicator(bleComm)
            bleComm.setReceiver(this.msgReceiver.bind(this))
            return bleComm.connect()
        }
        return Promise.reject(new Error('No communication device'))
    }
}

export default new Communicator()

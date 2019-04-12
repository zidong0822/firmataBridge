import React from 'react'
import FirmataBridge from '../communictor/FirmataBridge'
class Root extends React.Component {
    constructor(){
        super()
        new FirmataBridge()
    }
}

export default Root

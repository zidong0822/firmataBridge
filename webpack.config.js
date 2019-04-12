const path = require("path");
const webpack = require('webpack')
const HtmlWebpackPlugin = require("html-webpack-plugin");
var CopyWebpackPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

var autoprefixer = require('autoprefixer');
var postcssVars = require('postcss-simple-vars');
var postcssImport = require('postcss-import');

const getConfig = function (key, defaults) {
    return typeof process.env[key] !== 'undefined' && process.env[key] !== '' ? process.env[key] : defaults
}

module.exports = {
    entry: {
        'lib': ['react', 'react-dom'],
        'firmata': './src/playground/index.jsx'
    },
    target: 'web',
    output: {
        path: path.resolve(__dirname, 'build'),
        filename: '[name].js',
        publicPath: './',
        chunkFilename:'[name]_[chunkhash:8].js'
    },
    module: {
        rules: [
            {
                test: /\.jsx?$/,
                include: [path.resolve(__dirname, 'src')],
                loader: 'babel-loader',
                options: {
                    plugins: [
                        [
                            "import", [
                            {
                                "libraryName": "antd-mobile",
                                'libraryDirectory': 'lib',
                                "style": 'css'
                            },
                            {
                                "libraryName": "antd",
                                'libraryDirectory': 'lib',
                                "style": 'css'
                            }
                        ]
                        ]
                    ]

                }
            },
            {
                test: /\.css$/,
                use: [{
                    loader: 'style-loader'
                }, {
                    loader: 'css-loader',
                    options: {
                        modules: true,
                        importLoaders: 1,
                        camelCase: true,
                        localIdentName: '[name]_[local]_[hash:base64:5]'
                    }
                }, {
                    loader: 'postcss-loader',
                    options: {
                        ident: 'postcss',
                        plugins: function () {
                            return [
                                postcssImport,
                                postcssVars,
                                autoprefixer({
                                    browsers: ['last 3 versions', 'Safari >= 8', 'iOS >= 8']
                                })
                            ];
                        }
                    }
                }],
                exclude: /node_modules/
            },
            {
                test: /\.css$/,
                use: [
                    {loader: 'style-loader'},
                    {loader: 'css-loader'}
                ],
                include: /node_modules/
            },
            {
                test: /\.(html)$/,
                use: {
                    loader: 'html-loader',
                    options: {
                        attrs: [':data-src'],
                        minimize: false
                    }
                }
            },
            {
                test: /\.(png|svg|gif|jpeg|ttf)$/,
                use: [
                    {
                        loader: 'file-loader',
                        options: {
                            name: '[path][name].[ext]',

                        }
                    }
                ]
            }
        ]
    },
    plugins: [
        new webpack.EnvironmentPlugin({
            PLATFORM: getConfig('PLATFORM', 'desktop')
        }),
        new webpack.DefinePlugin({
            'process.env': {
                'PLATFORM': JSON.stringify(process.env.PLATFORM)
            }
        }),
        new HtmlWebpackPlugin({
            template: "./src/index.html"
        }),
        new MiniCssExtractPlugin({
            filename: "[name]-[hash].css",
            chunkFilename: "[id][hash].css"
        }),

    ]
};

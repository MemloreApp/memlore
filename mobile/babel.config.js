// babel-preset-expo adds the react-native-worklets plugin itself; Unistyles 3
// processes every file under app/ (its install docs: plugin root 'app').
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [['react-native-unistyles/plugin', { root: 'app' }]],
  };
};

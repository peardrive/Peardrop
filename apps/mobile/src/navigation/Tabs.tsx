// the bottom tab navigator was removed when the app collapsed
// to a single unified main page. The root now uses a native stack with
// just two screens: Main and Settings. The file is kept under the same
// `Tabs.tsx` name to minimize import churn in app/index.tsx during the
// transition.
import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import MainScreen from "../screens/MainScreen";
import SettingsScreen from "../screens/SettingsScreen";

const Stack = createNativeStackNavigator();

export default function RootNav() {
  return (
    <Stack.Navigator
      initialRouteName="Main"
      screenOptions={{ headerShown: false, animation: "slide_from_right" }}
    >
      <Stack.Screen name="Main" component={MainScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
    </Stack.Navigator>
  );
}

import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import OnboardingFlow from '../components/onboarding/OnboardingFlow';
import { useOnboarding } from '../hooks/useOnboarding';

export default function OnboardingScreen() {
  const router = useRouter();
  const { hasCompletedOnboarding, isLoading, markOnboardingComplete, trackOnboardingEvent } = useOnboarding();

  useEffect(() => {
    // Track onboarding start
    trackOnboardingEvent('onboarding_started', {
      timestamp: Date.now(),
    });
  }, [trackOnboardingEvent]);

  const handleComplete = async () => {
    await markOnboardingComplete();
    trackOnboardingEvent('onboarding_completed', {
      timestamp: Date.now(),
    });
    router.replace('/');
  };

  const handleSkip = () => {
    void (async () => {
      await markOnboardingComplete();
      await trackOnboardingEvent('onboarding_skipped', {
        timestamp: Date.now(),
      });
      router.replace('/');
    })();
  };

  if (isLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator />
      </View>
    );
  }

  // If already completed, redirect to home
  if (hasCompletedOnboarding) {
    router.replace('/');
    return null;
  }

  return (
    <OnboardingFlow
      onComplete={handleComplete}
      onSkip={handleSkip}
    />
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

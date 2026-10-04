/**
 * 主打团商城 - MallContext 状态上下文
 * 技术服务方：雍彻科技
 */

import React, { createContext, useContext, useState } from 'react';
import { DomainType, MallContextType } from '../types';
import { defaultTermsAccepted } from '../services/termsAcceptance';

const MallContext = createContext<MallContextType | undefined>(undefined);

function initialDomain(): DomainType {
  return typeof window === 'undefined' ? '' : window.location.hostname.toLowerCase();
}

export const MallProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const currentDomain = initialDomain();
  const [acceptedTerms, setAcceptedTerms] = useState<boolean>(() => defaultTermsAccepted('login'));

  return (
    <MallContext.Provider
      value={{
        currentDomain,
        acceptedTerms,
        setAcceptedTerms,
      }}
    >
      {children}
    </MallContext.Provider>
  );
};

export const useMallContext = (): MallContextType => {
  const context = useContext(MallContext);
  if (!context) {
    throw new Error('useMallContext must be used within a MallProvider');
  }
  return context;
};

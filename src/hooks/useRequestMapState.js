import { useCallback, useEffect, useMemo, useState } from "react";
import { swChannel, subscribeToServiceWorkerMessages } from "../lib/swChannel";

export function useRequestMapState({ defaultCenter, onContractEvent }) {
  const [requestId, setRequestId] = useState(null);
  const [requestStatus, setRequestStatus] = useState("idle");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [requestError, setRequestError] = useState("");
  const [responders, setResponders] = useState([]);
  const [popupMarker, setPopupMarker] = useState(null);
  const [myRequests, setMyRequests] = useState([]);
  const [myRequestsLoading, setMyRequestsLoading] = useState(false);
  const [openRequests, setOpenRequests] = useState(new globalThis.Map());
  const [openRequestsLoading, setOpenRequestsLoading] = useState(true);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [offerSubmitting, setOfferSubmitting] = useState(false);
  const [lastOfferReceipt, setLastOfferReceipt] = useState(null);
  const [trackingRequestId, setTrackingRequestId] = useState(null);
  const [trackingIndex, setTrackingIndex] = useState(null);
  const [responderArrived, setResponderArrived] = useState(false);
  const [arrivalSubmitting, setArrivalSubmitting] = useState(false);
  const [arrivalThanksOpen, setArrivalThanksOpen] = useState(false);
  const [requesterLocation, setRequesterLocation] = useState(null);
  const [settledViewport, setSettledViewport] = useState(() => ({
    longitude: defaultCenter[1],
    latitude: defaultCenter[0],
    zoom: 2,
  }));

  const openRequestsArray = useMemo(
    () => Array.from(openRequests.values()),
    [openRequests],
  );

  // Issue #516: subscribe to cross-tab contract update events so a request /
  // responder change made in another tab (or polled by the leader tab) refreshes
  // this view instantly instead of waiting for the next local poll interval.
  useEffect(() => {
    if (typeof onContractEvent !== "function") return undefined;
    const handleMessage = (message) => {
      if (message?.type !== "CONTRACT_EVENT") return;
      onContractEvent(message.payload);
    };
    const unsubChannel = swChannel.subscribe(handleMessage);
    const unsubSw = subscribeToServiceWorkerMessages(handleMessage);
    return () => {
      unsubChannel();
      unsubSw();
    };
  }, [onContractEvent]);

  const syncSettledViewport = useCallback((event) => {
    const viewState = event?.viewState;
    if (!viewState) return;
    setSettledViewport({
      longitude: viewState.longitude,
      latitude: viewState.latitude,
      zoom: viewState.zoom,
      pitch: viewState.pitch,
      bearing: viewState.bearing,
    });
  }, []);

  return {
    requestId,
    setRequestId,
    requestStatus,
    setRequestStatus,
    submitting,
    setSubmitting,
    submitError,
    setSubmitError,
    requestError,
    setRequestError,
    responders,
    setResponders,
    popupMarker,
    setPopupMarker,
    myRequests,
    setMyRequests,
    myRequestsLoading,
    setMyRequestsLoading,
    openRequests,
    setOpenRequests,
    openRequestsLoading,
    setOpenRequestsLoading,
    openRequestsArray,
    selectedRequest,
    setSelectedRequest,
    offerSubmitting,
    setOfferSubmitting,
    lastOfferReceipt,
    setLastOfferReceipt,
    trackingRequestId,
    setTrackingRequestId,
    trackingIndex,
    setTrackingIndex,
    responderArrived,
    setResponderArrived,
    arrivalSubmitting,
    setArrivalSubmitting,
    arrivalThanksOpen,
    setArrivalThanksOpen,
    requesterLocation,
    setRequesterLocation,
    settledViewport,
    syncSettledViewport,
  };
}
